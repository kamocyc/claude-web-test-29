import { STATION_WALK_RADIUS, TRANSIT_PREFERENCE, WALK_SPEED } from '../config';
import { manhattan } from '../core/grid';
import { BuildingType, type BuildingId, type TileIndex } from '../core/types';
import type { Building } from '../world/buildings';
import { expectedWaitTicks, rideTicks, stopsFor, type TransitLine } from '../world/transit';
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
 * No interchanges: the origin and destination stations must share a line.
 * A multi-line search needs a graph over lines rather than tiles, and one line
 * is enough to make a rail network worth building; the limitation is called
 * out in the README rather than hidden.
 */
export function planTransit(world: World, from: Building, to: Building): TransitPlan | null {
  const origins = stationsNear(world, from.tile);
  if (origins.length === 0) return null;
  const targets = stationsNear(world, to.tile);
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

  const roads = findPath(world.roads, from.accessRoad, to.accessRoad);
  if (!roads) return null;
  return [from.tile, ...roads, to.tile];
}

function stationsNear(world: World, tile: TileIndex): Building[] {
  const out: Building[] = [];
  for (const b of world.buildings) {
    if (!b.alive || b.type !== BuildingType.Station) continue;
    if (manhattan(b.tile, tile) <= STATION_WALK_RADIUS) out.push(b);
  }
  return out;
}

/**
 * Transit must be meaningfully faster, not merely faster, before someone
 * changes mode -- otherwise a one-tick difference flips the whole city onto
 * the train.
 */
export function transitWins(transitTicks: number, carTicks: number): boolean {
  return transitTicks < carTicks * TRANSIT_PREFERENCE;
}
