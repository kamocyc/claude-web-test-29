import { MAX_RAIL_STEP } from '../config';
import { manhattan, neighbor, tileX, tileY } from '../core/grid';
import { BuildingType, Terrain, type BuildingId, type Direction, type TileIndex } from '../core/types';
import { findPath } from '../sim/pathfinding';
import { LineMode, type TransitLine } from './transit';
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
    const segment = findPath(world.rails, prev.platform, station.platform, world.railStep);
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

/**
 * Lay a bus route out over the roads: the round trip a service makes, and
 * where along it each stop falls.
 *
 * The same shape as the rail layout above, over the road network instead --
 * and, unlike the railway, nothing is ever built. A bus route is a claim
 * about roads that already exist, which is exactly what makes it the cheap
 * answer: no track, no alignment, no land taken.
 */
export function layoutRoadRoute(world: World, stops: BuildingId[]): RouteLayout | null {
  if (stops.length < 2) return null;

  const oneWay: TileIndex[] = [];
  const stopOneWay: number[] = [];

  for (let i = 0; i < stops.length; i++) {
    const stop = world.buildings[stops[i]];
    if (!stop || !stop.alive || stop.type !== BuildingType.BusStop) return null;
    world.refreshAccess(stop);
    if (stop.accessRoad < 0) return null;

    if (i === 0) {
      oneWay.push(stop.accessRoad);
      stopOneWay.push(0);
      continue;
    }

    const prev = world.buildings[stops[i - 1]];
    const segment = findPath(world.roads, prev.accessRoad, stop.accessRoad, world.roadStep);
    if (!segment || segment.length < 2) return null;

    for (let k = 1; k < segment.length; k++) oneWay.push(segment[k]);
    stopOneWay.push(oneWay.length - 1);
  }

  const lastIndex = oneWay.length - 1;
  const route = oneWay.slice();
  for (let i = lastIndex - 1; i >= 0; i--) route.push(oneWay[i]);

  const stopAt = stopOneWay.slice();
  for (let i = stops.length - 2; i >= 1; i--) {
    stopAt.push(2 * lastIndex - stopOneWay[i]);
  }

  return { route, stopAt };
}

/**
 * Open a bus route through the chosen stops.
 *
 * Deliberately much less machinery than its rail counterpart, because that is
 * the difference between the two modes: a railway has to be built and a bus
 * route only has to be *declared*. If the roads already join the stops up the
 * service runs today; if they do not, the answer is a road, which the player
 * was going to want anyway.
 */
export function createBusLine(world: World, stops: BuildingId[]): TransitLine | null {
  const layout = layoutRoadRoute(world, stops);
  if (!layout) return null;
  return world.addLine(stops.slice(), layout.route, layout.stopAt, LineMode.Road);
}

export interface LineResult {
  line: TransitLine | null;
  /** True when track had to be laid to join the chosen stations up. */
  builtTrack: boolean;
}

/**
 * Build a line through the chosen stations, laying whatever track is missing.
 *
 * This is the whole railway-building interaction: pick two or more stations in
 * the order a service should call at them, and the alignment follows. Stations
 * that have no platform yet get one, and consecutive stations that are not
 * already joined are connected by new track.
 *
 * The alternative -- refusing until the player had drawn a continuous railway
 * by hand -- made the tool feel broken far more often than it made anyone
 * think about alignment. Where the stations go is the decision worth making;
 * the track between them is a consequence of it.
 *
 * Nothing is ever bulldozed to make room, and nothing is left behind on
 * failure: if a gap cannot be crossed (water, or buildings in the way) every
 * tile laid during the attempt is taken back up before returning.
 */
export function createLineThrough(world: World, stations: BuildingId[]): LineResult {
  if (stations.length < 2) return { line: null, builtTrack: false };

  const laid: TileIndex[] = [];
  const platforms = new Map<BuildingId, TileIndex>();
  const rollback = (): LineResult => {
    for (let i = laid.length - 1; i >= 0; i--) world.removeRail(laid[i]);
    // A platform assigned during the attempt now points at bare ground.
    for (const [id, before] of platforms) world.buildings[id].platform = before;
    return { line: null, builtTrack: false };
  };

  for (const id of stations) {
    const station = world.buildings[id];
    if (station) platforms.set(id, station.platform);
    if (!ensurePlatform(world, id, laid)) return rollback();
  }
  if (!connectStations(world, stations, laid)) return rollback();

  const layout = layoutRoute(world, stations);
  if (!layout) return rollback();
  return {
    line: world.addLine(stations.slice(), layout.route, layout.stopAt),
    builtTrack: laid.length > 0,
  };
}

/**
 * Give a station a platform tile if it has not got one, preferring the side
 * away from the road it is entered from -- passengers come in off the
 * pavement, the trains call at the other side.
 */
function ensurePlatform(world: World, id: BuildingId, laid: TileIndex[]): boolean {
  const station = world.buildings[id];
  if (!station || !station.alive || station.type !== BuildingType.Station) return false;
  if (station.platform >= 0 && world.map.isRail(station.platform)) return true;

  const existing = world.adjacentRail(station.tile);
  if (existing >= 0) {
    station.platform = existing;
    return true;
  }

  const candidates = neighborsOf(station.tile)
    .filter((tile) => tile !== station.accessRoad && canLayRail(world, tile)
      && world.railGradeAllows(tile, 0))
    .sort((a, b) => oppositeScore(station.tile, station.accessRoad, b)
      - oppositeScore(station.tile, station.accessRoad, a));
  if (candidates.length === 0) return false;

  const platform = candidates[0];
  if (world.placeRail(platform)) laid.push(platform);
  station.platform = platform;
  return true;
}

/** 1 for the tile directly opposite the access road, 0 otherwise. */
function oppositeScore(tile: TileIndex, accessRoad: TileIndex, candidate: TileIndex): number {
  const dx = tileX(candidate) - tileX(tile);
  const dy = tileY(candidate) - tileY(tile);
  const rx = tileX(accessRoad) - tileX(tile);
  const ry = tileY(accessRoad) - tileY(tile);
  return dx === -rx && dy === -ry ? 1 : 0;
}

function neighborsOf(tile: TileIndex): TileIndex[] {
  const out: TileIndex[] = [];
  for (let dir = 0; dir < 4; dir++) {
    const n = neighbor(tile, dir as Direction);
    if (n >= 0) out.push(n);
  }
  return out;
}

/** Build the line only if the track already connects every station. */
export function createLine(world: World, stations: BuildingId[]): TransitLine | null {
  const layout = layoutRoute(world, stations);
  if (!layout) return null;
  return world.addLine(stations.slice(), layout.route, layout.stopAt);
}

/** Lay whatever track is missing between consecutive stations. */
function connectStations(world: World, stations: BuildingId[], laid: TileIndex[]): boolean {
  for (let i = 1; i < stations.length; i++) {
    const a = world.buildings[stations[i - 1]];
    const b = world.buildings[stations[i]];
    if (!a || !b || !a.alive || !b.alive) return false;
    if (a.platform < 0 || b.platform < 0) return false;
    if (findPath(world.rails, a.platform, b.platform)) continue;
    if (!layTrack(world, a.platform, b.platform, laid)) return false;
  }
  return true;
}

/**
 * Route new track between two platforms and lay it.
 *
 * A hand-drawn L is not enough: the direct line between two platforms very
 * often runs through the destination's own station building, and any river or
 * block of housing in between defeats it too. So this is a search -- shortest
 * path over the tiles track may legally occupy -- with a small penalty per
 * turn, which is what keeps the result looking like a railway rather than a
 * staircase. Nothing is placed until the whole route is known, so a refused
 * connection never leaves a stub of track behind.
 */
function layTrack(world: World, from: TileIndex, to: TileIndex, laid: TileIndex[]): boolean {
  const route = findRailRoute(world, from, to);
  if (!route) return false;
  for (const tile of route) {
    if (world.placeRail(tile)) laid.push(tile);
  }
  return true;
}

function canLayRail(world: World, tile: TileIndex): boolean {
  if (tile < 0) return false;
  if (world.map.isRail(tile)) return true;
  return world.map.terrain[tile] !== Terrain.Water && world.map.building[tile] === -1;
}

/**
 * Whether track may run between two tiles at all: the gradient limit, applied
 * to the alignment search rather than only to the tile being placed.
 *
 * Checking it here is what makes the search *route around* a slope it cannot
 * climb, instead of driving a line straight at an escarpment and failing at
 * the last tile with everything already laid.
 */
function railStepAllowed(world: World, from: TileIndex, to: TileIndex): boolean {
  return Math.abs(world.map.railHeight(to) - world.map.railHeight(from)) <= MAX_RAIL_STEP;
}

/** Cost of changing direction, in tiles. Straight track is cheaper track. */
const TURN_COST = 0.6;

/**
 * A* over layable tiles. States are (tile, arrival direction) rather than just
 * tiles, because the turn penalty makes the cost of standing on a tile depend
 * on how you got there.
 */
function findRailRoute(world: World, from: TileIndex, to: TileIndex): TileIndex[] | null {
  if (from === to) return [from];
  if (!canLayRail(world, from) || !canLayRail(world, to)) return null;

  const state = (tile: TileIndex, dir: number): number => tile * 4 + dir;
  const open: number[] = [];
  const gScore = new Map<number, number>();
  const cameFrom = new Map<number, number>();

  for (let dir = 0; dir < 4; dir++) {
    const s = state(from, dir);
    gScore.set(s, 0);
    open.push(s);
  }

  const heuristic = (tile: TileIndex): number => manhattan(tile, to);

  while (open.length > 0) {
    let bestAt = 0;
    let bestF = Infinity;
    for (let i = 0; i < open.length; i++) {
      const tile = (open[i] / 4) | 0;
      const f = (gScore.get(open[i]) ?? Infinity) + heuristic(tile);
      if (f < bestF) {
        bestF = f;
        bestAt = i;
      }
    }

    const current = open[bestAt];
    open[bestAt] = open[open.length - 1];
    open.pop();

    const tile = (current / 4) | 0;
    const arrivedBy = current % 4;
    if (tile === to) return reconstructRoute(cameFrom, current);

    const g = gScore.get(current) ?? Infinity;
    for (let dir = 0; dir < 4; dir++) {
      const next = neighbor(tile, dir as Direction);
      if (next < 0 || !canLayRail(world, next)) continue;
      if (!railStepAllowed(world, tile, next)) continue;

      const cost = g + 1 + (dir === arrivedBy ? 0 : TURN_COST);
      const nextState = state(next, dir);
      if (cost < (gScore.get(nextState) ?? Infinity)) {
        gScore.set(nextState, cost);
        cameFrom.set(nextState, current);
        open.push(nextState);
      }
    }
  }
  return null;
}

function reconstructRoute(cameFrom: Map<number, number>, end: number): TileIndex[] {
  const tiles: TileIndex[] = [];
  let cur = end;
  for (;;) {
    tiles.push((cur / 4) | 0);
    const prev = cameFrom.get(cur);
    if (prev === undefined) break;
    cur = prev;
  }
  tiles.reverse();
  return tiles;
}
