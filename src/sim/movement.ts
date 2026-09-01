import {
  CAR_FREE_SPEED,
  GRIDLOCK_RELEASE_TICKS,
  TILE_CAR_CAPACITY,
  WALK_SPEED,
} from '../config';
import { directionBetween } from '../core/grid';
import { CitizenState, TravelMode, type Direction, type TileIndex } from '../core/types';
import type { World } from '../world/world';
import { desiredSpeed, stepSpeed } from './carFollowing';
import { tileCenterX, tileCenterY, type Citizen } from './citizen';
import type { Crossings } from './crossings';
import type { Occupancy } from './occupancy';

/** Index of the last road tile on the route; beyond it the citizen walks. */
function driveEndIndex(path: TileIndex[]): number {
  return path.length - 2;
}

function segmentOf(c: Citizen): number {
  const path = c.path!;
  return Math.min(path.length - 2, Math.floor(c.s));
}

export function isDrivingSegment(world: World, c: Citizen, seg: number): boolean {
  if (c.mode !== TravelMode.Car) return false;
  const path = c.path!;
  return world.map.isRoad(path[seg]) && world.map.isRoad(path[seg + 1]);
}

export function headingOf(c: Citizen, seg: number): Direction | -1 {
  const path = c.path!;
  return directionBetween(path[seg], path[seg + 1]);
}

/**
 * Phase one of the tick: publish where every car is. Split from the update so
 * that each car sees the same snapshot, making the result independent of the
 * order citizens happen to sit in the array.
 */
export function registerOccupancy(world: World, occ: Occupancy): void {
  occ.clear();
  for (const c of world.citizens) {
    if (!c.path || c.state === CitizenState.AtHome || c.state === CitizenState.AtWork) continue;
    const seg = segmentOf(c);
    if (!isDrivingSegment(world, c, seg)) continue;
    const dir = headingOf(c, seg);
    if (dir === -1) continue;
    occ.add(c.path[seg], { id: c.id, dir, progress: c.s - seg });
  }
}

/** Phase two: advance one citizen by a tick. Returns true when it arrived. */
export function advanceCitizen(
  world: World,
  c: Citizen,
  occ: Occupancy,
  crossings: Crossings,
): boolean {
  const path = c.path!;
  const seg = segmentOf(c);
  const local = c.s - seg;

  c.prevX = c.x;
  c.prevY = c.y;

  if (isDrivingSegment(world, c, seg)) {
    const dir = headingOf(c, seg) as Direction;
    const released = c.blockedTicks >= GRIDLOCK_RELEASE_TICKS;
    const gap = gapToLeader(world, c, occ, seg, local, dir, released);
    const stopDistance = distanceToStop(world, c, occ, crossings, seg, dir);

    c.v = stepSpeed(c.v, desiredSpeed(CAR_FREE_SPEED, gap, stopDistance), CAR_FREE_SPEED);
    c.blockedTicks = c.v < 1e-4 ? c.blockedTicks + 1 : 0;
  } else {
    c.v = WALK_SPEED;
    c.blockedTicks = 0;
  }

  c.s += c.v;

  const end = path.length - 1;
  if (c.s >= end) {
    c.s = end;
    c.v = 0;
    setPositionFromPath(c);
    return true;
  }

  setPositionFromPath(c);
  return false;
}

function gapToLeader(
  world: World,
  c: Citizen,
  occ: Occupancy,
  seg: number,
  local: number,
  dir: Direction,
  released: boolean,
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
  const into = occ.gapIntoTile(path[next], nextDir === -1 ? dir : nextDir, released);
  return into === Infinity ? Infinity : 1 - local + into;
}

function distanceToStop(
  world: World,
  c: Citizen,
  occ: Occupancy,
  crossings: Crossings,
  seg: number,
  dir: Direction,
): number {
  const path = c.path!;
  // Where driving ends and the walk to the front door begins.
  let stop = driveEndIndex(path) - c.s;

  const next = seg + 1;
  if (next <= driveEndIndex(path) && world.map.isRoad(path[next])) {
    // A closed level crossing is a hard stop, and unlike tile capacity it has
    // no release valve -- waiting longer must never let a car onto the rails.
    if (crossings.isClosed(path[next])) {
      return Math.max(0, Math.min(stop, next - c.s));
    }
    const nextDir = next < path.length - 1 ? directionBetween(path[next], path[next + 1]) : dir;
    const blocked = occ.blockingCount(path[next], nextDir === -1 ? dir : nextDir);
    // Soft capacity: a car stuck long enough is let through anyway, so a ring
    // of mutually-blocking intersections drains instead of freezing forever.
    if (blocked >= TILE_CAR_CAPACITY && c.blockedTicks < GRIDLOCK_RELEASE_TICKS) {
      stop = Math.min(stop, next - c.s);
    }
  }
  return Math.max(0, stop);
}

export function setPositionFromPath(c: Citizen): void {
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

/** True when the route no longer exists, e.g. the player bulldozed it. */
export function pathIsBroken(world: World, c: Citizen): boolean {
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
