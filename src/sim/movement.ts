import {
  GIVE_WAY_NOSE_IN,
  GRIDLOCK_CRAWL_RATIO,
  GRIDLOCK_RELEASE_TICKS,
  STOP_LINE_SETBACK,
  TILE_CAR_CAPACITY,
  WALK_SPEED,
} from '../config';
import { directionBetween } from '../core/grid';
import { TravelMode, type Direction, type TileIndex } from '../core/types';
import type { World } from '../world/world';
import { brakingSpeed, desiredSpeed, stepSpeed } from './carFollowing';
import { tileCenterX, tileCenterY } from './citizen';
import type { Crossings } from './crossings';
import type { Occupancy } from './occupancy';
import type { Signals } from './signals';
import { gradeSpeedFactor } from './gradient';
import { findPath } from './pathfinding';
import { occupantSize, type RoadAgent } from './vehicle';

/**
 * People feel a hill about as much as a car does. Being on foot is the one
 * mode where going up really is the whole cost of the journey.
 */
const WALK_GRADE_SENSITIVITY = 1.2;

/** What the climb on this segment of a route does to the free speed on it. */
export function gradeFactor(
  world: World,
  path: TileIndex[],
  seg: number,
  sensitivity: number,
): number {
  const climb = world.map.travelHeight(path[seg + 1]) - world.map.travelHeight(path[seg]);
  return gradeSpeedFactor(climb, sensitivity);
}

/** Index of the last road tile on the route; beyond it the agent walks. */
function driveEndIndex(path: TileIndex[]): number {
  return path.length - 2;
}

function segmentOf(c: RoadAgent): number {
  const path = c.path!;
  return Math.min(path.length - 2, Math.floor(c.s));
}

export function isDrivingSegment(world: World, c: RoadAgent, seg: number): boolean {
  if (c.mode !== TravelMode.Car) return false;
  const path = c.path!;
  return world.map.isRoad(path[seg]) && world.map.isRoad(path[seg + 1]);
}

export function headingOf(c: RoadAgent, seg: number): Direction | -1 {
  const path = c.path!;
  return directionBetween(path[seg], path[seg + 1]);
}

/**
 * Phase one of the tick: publish where every vehicle is. Split from the update
 * so that each vehicle sees the same snapshot, making the result independent
 * of the order agents happen to sit in their arrays -- which is what lets
 * lorries and cars share the road without either one going first.
 */
export function registerVehicle(world: World, occ: Occupancy, c: RoadAgent): void {
  if (!c.path) return;
  const seg = segmentOf(c);
  if (!isDrivingSegment(world, c, seg)) return;
  const dir = headingOf(c, seg);
  if (dir === -1) return;
  occ.add(c.path[seg], {
    id: c.id,
    dir,
    progress: c.s - seg,
    speedRatio: c.v / c.profile.freeSpeed,
    size: occupantSize(c.profile),
  });
}

/** Phase two: advance one vehicle by a tick. Returns true when it arrived. */
export function advanceVehicle(
  world: World,
  c: RoadAgent,
  occ: Occupancy,
  crossings: Crossings,
  signals: Signals,
  tick: number,
): boolean {
  const path = c.path!;
  const seg = segmentOf(c);
  const local = c.s - seg;

  c.prevX = c.x;
  c.prevY = c.y;

  const driving = isDrivingSegment(world, c, seg);
  let hold: Hold = FREE_ROAD;
  if (driving) {
    const dir = headingOf(c, seg) as Direction;
    const released = c.blockedTicks >= GRIDLOCK_RELEASE_TICKS;
    const gap = gapToLeader(world, c, occ, seg, local, dir);
    hold = distanceToStop(world, c, occ, crossings, signals, tick, seg, dir, released);

    // A hill is a speed limit, not a separate system: the free speed for this
    // one segment is lowered and the following model does the rest, so a
    // vehicle labours up a slope and the queue behind it labours too.
    const free = c.profile.freeSpeed * gradeFactor(world, path, seg, c.profile.gradeSensitivity);
    c.v = stepSpeed(c.v, desiredSpeed(free, gap, hold.distance, c.profile), free, c.profile);
  } else {
    c.v = WALK_SPEED * gradeFactor(world, path, seg, WALK_GRADE_SENSITIVITY);
  }

  c.s += c.v;
  updateBlockedTicks(c, seg, driving, hold.mandatory);

  const end = path.length - 1;
  if (c.s >= end) {
    c.s = end;
    c.v = 0;
    // Arriving is the strongest form of having got somewhere, so whatever the
    // trip queued in is over: leaving the count standing would follow the
    // traveller into their front door and out again on their next trip.
    c.blockedTicks = 0;
    setPositionFromPath(c);
    return true;
  }

  setPositionFromPath(c);
  return false;
}

/**
 * How long this vehicle has been going nowhere, which is what arms the
 * gridlock release.
 *
 * Two things it deliberately is not. It is not a stopwatch on standing still:
 * a vehicle inching forward a thousandth of a tile per tick is stuck by any
 * measure a player would recognise, and testing for an exact standstill let
 * such a vehicle reset the counter forever -- which is how a lorry could sit
 * at a junction for the length of a working day. And it is not reset by the
 * first twitch of movement: it clears when the vehicle actually gets
 * somewhere, meaning into the next tile. A release that ended the moment the
 * wheels turned would let a vehicle roll a hundredth of a tile, re-block
 * itself just short of the junction, and start the whole wait again.
 *
 * Waiting at a red light or a closed level crossing is not being stuck at
 * all, so it does not count: those holds have no release and never need one.
 */
function updateBlockedTicks(
  c: RoadAgent,
  seg: number,
  driving: boolean,
  mandatory: boolean,
): void {
  const path = c.path!;
  const movedOn = Math.min(path.length - 2, Math.floor(c.s)) !== seg;
  if (!driving || mandatory || movedOn) {
    c.blockedTicks = 0;
    return;
  }
  if (c.v >= c.profile.freeSpeed * GRIDLOCK_CRAWL_RATIO) return;
  c.blockedTicks++;
}

function gapToLeader(
  world: World,
  c: RoadAgent,
  occ: Occupancy,
  seg: number,
  local: number,
  dir: Direction,
): number {
  const inTile = occ.gapAheadInTile(c.path![seg], dir, local, c.id);
  if (inTile !== Infinity) return inTile;

  // Nothing ahead in this tile: look into the next one, measuring from our
  // own position through the tile boundary.
  const path = c.path!;
  const next = seg + 1;
  if (next > driveEndIndex(path)) return Infinity;
  if (!world.map.isRoad(path[next])) return Infinity;

  const nextDir = next < path.length - 1 ? directionBetween(path[next], path[next + 1]) : dir;
  const into = occ.gapIntoTile(path[next], nextDir === -1 ? dir : nextDir);
  return into === Infinity ? Infinity : 1 - local + into;
}

/**
 * Where a vehicle has to stop, and whether the thing stopping it is one it
 * simply has to obey. A red light and a closed crossing are absolute; a full
 * tile and traffic crossing in front of us are not, and have the release.
 */
interface Hold {
  distance: number;
  mandatory: boolean;
}

const FREE_ROAD: Hold = { distance: Infinity, mandatory: false };

function distanceToStop(
  world: World,
  c: RoadAgent,
  occ: Occupancy,
  crossings: Crossings,
  signals: Signals,
  tick: number,
  seg: number,
  dir: Direction,
  released: boolean,
): Hold {
  const path = c.path!;
  // Where driving ends and the walk to the front door begins. This one is a
  // destination rather than a hold, so it is the boundary itself: a vehicle
  // that stopped short of it would never arrive.
  let stop = driveEndIndex(path) - c.s;

  const next = seg + 1;
  if (next <= driveEndIndex(path) && world.map.isRoad(path[next])) {
    // A light or a barrier holds us just short of the tile, so that we are
    // still in our own approach while we wait and the rule holding us keeps
    // applying to us.
    const line = next - c.s - STOP_LINE_SETBACK;

    // A closed level crossing is a hard stop, and unlike tile capacity it has
    // no release valve -- waiting longer must never let a car onto the rails.
    if (crossings.isClosed(path[next])) {
      return { distance: Math.max(0, Math.min(stop, line)), mandatory: true };
    }
    const nextDir = next < path.length - 1 ? directionBetween(path[next], path[next + 1]) : dir;
    // A red signal is the same kind of hard stop, and for the same reason:
    // the gridlock release must never be able to push a car through it.
    if (holdsAtSignal(c, signals, path[next], dir, tick, next - c.s)) {
      return { distance: Math.max(0, Math.min(stop, line)), mandatory: true };
    }
    const heading = nextDir === -1 ? dir : nextDir;
    // Give way to whatever is crossing the tile we are about to enter: creep
    // up to the mouth of the junction and no further while it is in use. Like
    // the capacity below this is soft -- a vehicle held long enough goes
    // anyway -- because two queues can otherwise hold each other at a
    // junction forever, each of them merely in the other's way.
    if (!released && occ.crossingTraffic(path[next], heading)) {
      stop = Math.min(stop, next - c.s + GIVE_WAY_NOSE_IN);
    }
    const blocked = occ.blockingCount(path[next], heading);
    // Soft capacity: a car stuck long enough is let through anyway, so a ring
    // of mutually-blocking intersections drains instead of freezing forever.
    if (blocked >= TILE_CAR_CAPACITY && !released) {
      stop = Math.min(stop, next - c.s + GIVE_WAY_NOSE_IN);
    }
  }
  return { distance: Math.max(0, stop), mandatory: false };
}

/**
 * Whether this car has to stop at the signal on `tile`.
 *
 * A signal changes instantly, so when it does there are always cars closer to
 * the line than they can possibly stop in. Braking one of those anyway would
 * leave it standing *on* the junction, blocking the movement that just got the
 * green -- so it is treated as committed and carries on, clearing the box
 * during the all-red interval, exactly as a driver does on amber.
 *
 * The decision is made once and then latched on the citizen (see
 * `signalHold`), because the "could I still stop?" test stops being meaningful
 * once a car is easing up to the line at a crawl.
 */
function holdsAtSignal(
  c: RoadAgent,
  signals: Signals,
  tile: TileIndex,
  dir: Direction,
  tick: number,
  toStopLine: number,
): boolean {
  if (!signals.isSignalized(tile)) return false;

  if (!signals.isRed(tile, dir, tick)) {
    if (c.signalHold === tile) c.signalHold = -1;
    return false;
  }
  if (c.signalHold === tile) return true;
  if (!canStopWithin(c.v, toStopLine, c.profile.decelMax)) return false;

  c.signalHold = tile;
  return true;
}

/**
 * Whether a car at speed `v` can still be stopped inside `distance` using
 * emergency braking. Uses the same integration-aware formula the car-following
 * model does, so the answer agrees with what the car will actually manage.
 */
function canStopWithin(v: number, distance: number, decelMax: number): boolean {
  return v <= brakingSpeed(Math.max(0, distance), decelMax);
}

export function setPositionFromPath(c: RoadAgent): void {
  const path = c.path!;
  const seg = Math.min(path.length - 2, Math.floor(c.s));
  const t = c.s - seg;
  const ax = tileCenterX(path[seg]);
  const ay = tileCenterY(path[seg]);
  const bx = tileCenterX(path[seg + 1]);
  const by = tileCenterY(path[seg + 1]);
  c.x = ax + (bx - ax) * t;
  c.y = ay + (by - ay) * t;
}

/**
 * A door-to-door route from wherever a vehicle is standing to a building.
 *
 * Every road vehicle in the sim needs this and needs it to mean the same
 * thing: start from the tile actually under the vehicle (a yard, a stop, or
 * the road it is on), drive the roads, finish on the destination's own tile.
 * Lorries re-plan from where they stand rather than from their depot because
 * the interesting case is a road cut *under* them -- what matters is whether
 * there is a way on from here -- and that is just as true of a fire engine
 * and of a bus. The caller refreshes the destination's access road first:
 * only it knows whether the building is still supposed to be there.
 */
export function routeToBuilding(
  world: World,
  x: number,
  y: number,
  to: { tile: TileIndex; accessRoad: TileIndex },
): TileIndex[] | null {
  const here = world.map.at(Math.floor(x), Math.floor(y));
  if (here < 0) return null;
  const from = world.map.isRoad(here) ? here : world.adjacentRoad(here);
  if (from < 0) return null;
  if (to.accessRoad < 0) return null;

  const roads = findPath(world.roads, from, to.accessRoad, world.roadStep);
  if (!roads) return null;
  // Start from the yard the vehicle is actually standing in, so it drives out
  // of the gate rather than appearing on the road outside it.
  const yard = world.map.isRoad(here) ? [] : [here];
  return [...yard, ...roads, to.tile];
}

/** True when the route no longer exists, e.g. the player bulldozed it. */
export function pathIsBroken(world: World, c: RoadAgent): boolean {
  const path = c.path;
  if (!path) return true;
  const seg = segmentOf(c);
  for (let i = seg; i < Math.min(path.length - 1, seg + 3); i++) {
    const tile = path[i];
    const isEndpoint = i === 0 || i === path.length - 1;
    if (!isEndpoint && !world.map.isRoad(tile)) return true;
  }
  return false;
}
