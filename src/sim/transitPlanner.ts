import { TRANSIT_PREFERENCE, WALK_SPEED } from '../config';
import { manhattan } from '../core/grid';
import { type BuildingId, type TileIndex } from '../core/types';
import { isTransitStop, type Building } from '../world/buildings';
import {
  expectedWaitTicks,
  modeForStop,
  rideTicks,
  specForMode,
  stopsFor,
  type TransitLine,
} from '../world/transit';
import type { World } from '../world/world';
import { findPath } from './pathfinding';

export interface RideLeg {
  line: number;
  boardStation: BuildingId;
  alightStation: BuildingId;
  boardStop: number;
  alightStop: number;
}

export interface TransitPlan {
  toStation: TileIndex[];
  ride: RideLeg;
  fromStation: TileIndex[];
  totalTicks: number;
}

/**
 * Build the best single-line transit itinerary between two buildings, or null
 * if none beats walking distance.
 *
 * Buses and trains are searched together and judged by the same clock: what a
 * citizen wants is to be at work, and whether that happens on rails or on the
 * road is the city's problem, not theirs. A bus route with a stop outside the
 * front door regularly beats a railway with a ten-minute walk at each end,
 * which is exactly the trade the two modes are meant to offer.
 *
 * No interchanges: the origin and destination stops must share a line.
 * A multi-line search needs a graph over lines rather than tiles, and one line
 * is enough to make a network worth building; the limitation is called out in
 * the README rather than hidden.
 */
export function planTransit(world: World, from: Building, to: Building): TransitPlan | null {
  const origins = stopsNear(world, from.tile);
  if (origins.length === 0) return null;
  const targets = stopsNear(world, to.tile);
  if (targets.length === 0) return null;

  let best: TransitPlan | null = null;

  for (const line of world.activeLines) {
    for (const a of origins) {
      if (!line.stations.includes(a.id)) continue;
      for (const b of targets) {
        if (a.id === b.id || !line.stations.includes(b.id)) continue;

        const candidate = evaluate(world, line, from, to, a, b);
        if (candidate && (!best || candidate.totalTicks < best.totalTicks)) {
          best = candidate;
        }
      }
    }
  }
  return best;
}

function evaluate(
  world: World,
  line: TransitLine,
  from: Building,
  to: Building,
  boardAt: Building,
  alightAt: Building,
): TransitPlan | null {
  // Pick the direction round the line that actually gets there soonest --
  // on an out-and-back route a station is reachable two ways.
  let bestBoard = -1;
  let bestAlight = -1;
  let bestRide = Infinity;
  for (const boardStop of stopsFor(line, boardAt.id)) {
    for (const alightStop of stopsFor(line, alightAt.id)) {
      const ticks = rideTicks(line, boardStop, alightStop);
      if (ticks > 0 && ticks < bestRide) {
        bestRide = ticks;
        bestBoard = boardStop;
        bestAlight = alightStop;
      }
    }
  }
  if (bestBoard < 0) return null;

  const walkIn = walkRoute(world, from, boardAt);
  if (!walkIn) return null;
  const walkOut = walkRoute(world, alightAt, to);
  if (!walkOut) return null;

  const walkTicks = (walkIn.length - 1 + walkOut.length - 1) / WALK_SPEED;
  return {
    toStation: walkIn,
    ride: {
      line: line.id,
      boardStation: boardAt.id,
      alightStation: alightAt.id,
      boardStop: bestBoard,
      alightStop: bestAlight,
    },
    fromStation: walkOut,
    totalTicks: walkTicks + expectedWaitTicks(line) + bestRide,
  };
}

/** Door-to-door walking route between two buildings, via their access roads. */
function walkRoute(world: World, from: Building, to: Building): TileIndex[] | null {
  world.refreshAccess(from);
  world.refreshAccess(to);
  if (from.accessRoad < 0 || to.accessRoad < 0) return null;

  const roads = findPath(world.roads, from.accessRoad, to.accessRoad, world.roadStep);
  if (!roads) return null;
  return [from.tile, ...roads, to.tile];
}

/**
 * Every stop somebody standing on `tile` would consider walking to.
 *
 * How far that is depends on what the stop is: a station is worth a quarter
 * of an hour on foot, a bus stop is not. Asking the stop rather than assuming
 * one radius is what makes a dense network of cheap stops behave differently
 * from a sparse one of expensive ones.
 */
function stopsNear(world: World, tile: TileIndex): Building[] {
  const out: Building[] = [];
  for (const b of world.buildings) {
    if (!b.alive || !isTransitStop(b.type)) continue;
    const mode = modeForStop(b.type);
    if (mode === null) continue;
    if (manhattan(b.tile, tile) <= specForMode(mode).walkRadius) out.push(b);
  }
  return out;
}

/**
 * Transit must be meaningfully faster, not merely faster, before someone
 * changes mode -- otherwise a one-tick difference flips the whole city onto
 * the train.
 *
 * The threshold is a parameter rather than the constant directly, because the
 * fare-subsidy ordinance raises it: a subsidised rider will put up with a
 * slower journey, and that is the entire mechanism -- one number, moved,
 * where the mode choice was already being made.
 */
export function transitWins(
  transitTicks: number,
  carTicks: number,
  preference = TRANSIT_PREFERENCE,
): boolean {
  return transitTicks < carTicks * preference;
}
