import { BuildingType, type BuildingId, type TileIndex } from '../core/types';
import { findPath } from '../sim/pathfinding';
import type { TransitLine } from './transit';
import type { World } from './world';

export interface RouteLayout {
  route: TileIndex[];
  stopAt: number[];
}

/**
 * Turn an ordered list of stations into the round-trip rail route a line runs
 * on, or null if the track does not actually connect them.
 *
 * The stored route is the full there-and-back: A..B..C..B..A, with the first
 * and last tile identical so a train can simply wrap. Building it once here
 * means the train loop never needs a direction flag or a reversal case.
 */
export function layoutRoute(world: World, stations: BuildingId[]): RouteLayout | null {
  if (stations.length < 2) return null;

  const oneWay: TileIndex[] = [];
  const stopOneWay: number[] = [];

  for (let i = 0; i < stations.length; i++) {
    const station = world.buildings[stations[i]];
    if (!station || !station.alive || station.type !== BuildingType.Station) return null;
    if (station.platform < 0 || !world.map.isRail(station.platform)) return null;

    if (i === 0) {
      oneWay.push(station.platform);
      stopOneWay.push(0);
      continue;
    }

    const prev = world.buildings[stations[i - 1]];
    const segment = findPath(world.rails, prev.platform, station.platform);
    if (!segment || segment.length < 2) return null;

    // Drop the shared first tile so segments join without duplication.
    for (let k = 1; k < segment.length; k++) oneWay.push(segment[k]);
    stopOneWay.push(oneWay.length - 1);
  }

  const lastIndex = oneWay.length - 1;
  const route = oneWay.slice();
  for (let i = lastIndex - 1; i >= 0; i--) route.push(oneWay[i]);

  // Outbound stops keep their positions; the return leg mirrors them about the
  // far terminus. The origin is deliberately not repeated at the end -- the
  // wrap back to index 0 is that stop.
  const stopAt = stopOneWay.slice();
  for (let i = stations.length - 2; i >= 1; i--) {
    stopAt.push(2 * lastIndex - stopOneWay[i]);
  }

  return { route, stopAt };
}

/** Build the line if the track connects every station, otherwise null. */
export function createLine(world: World, stations: BuildingId[]): TransitLine | null {
  const layout = layoutRoute(world, stations);
  if (!layout) return null;
  return world.addLine(stations.slice(), layout.route, layout.stopAt);
}
