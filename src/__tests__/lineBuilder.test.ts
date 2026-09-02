import { describe, expect, it } from 'vitest';
import { idx, tileX, tileY } from '../core/grid';
import { Terrain, type BuildingId } from '../core/types';
import { findPath } from '../sim/pathfinding';
import { createLineThrough } from '../world/lineBuilder';
import { World } from '../world/world';

/**
 * Two isolated station sites: a road with a stub of track beside it, twice,
 * with nothing joining the two stubs. This is what the map looks like in
 * practice, because a station can only be placed against existing track.
 */
function twoIslands(): { world: World; stations: BuildingId[] } {
  const world = new World(5);
  world.map.terrain.fill(Terrain.Grass);

  const stations: BuildingId[] = [];
  for (const [x, y] of [[20, 20], [60, 40]] as const) {
    for (let k = -2; k <= 2; k++) world.placeRoad(idx(x + k, y));
    for (let k = -1; k <= 1; k++) world.placeRail(idx(x + k, y + 2));
    const b = world.placeStation(idx(x, y + 1));
    expect(b).not.toBeNull();
    stations.push(b!.id);
  }
  return { world, stations };
}

describe('building a line through chosen stations', () => {
  it('lays the missing track between stations that are not joined', () => {
    const { world, stations } = twoIslands();
    const a = world.buildings[stations[0]];
    const b = world.buildings[stations[1]];
    expect(findPath(world.rails, a.platform, b.platform)).toBeNull();

    const { line, builtTrack } = createLineThrough(world, stations);

    expect(builtTrack).toBe(true);
    expect(line).not.toBeNull();
    expect(findPath(world.rails, a.platform, b.platform)).not.toBeNull();
    // The route is a round trip, so it starts and ends at the same platform.
    expect(line!.route[0]).toBe(line!.route[line!.route.length - 1]);
    expect(line!.stations).toEqual(stations);
  });

  it('leaves an already-connected railway alone', () => {
    const { world, stations } = twoIslands();
    // Join the stubs by hand first.
    for (let x = 19; x <= 61; x++) world.placeRail(idx(x, 22));
    for (let y = 22; y <= 42; y++) world.placeRail(idx(61, y));
    for (let x = 59; x <= 61; x++) world.placeRail(idx(x, 42));
    const railBefore = world.map.rail.reduce((n, v) => n + v, 0);

    const { line, builtTrack } = createLineThrough(world, stations);

    expect(line).not.toBeNull();
    expect(builtTrack).toBe(false);
    expect(world.map.rail.reduce((n, v) => n + v, 0)).toBe(railBefore);
  });

  it('refuses, without leaving a stub behind, when water cuts the map in two', () => {
    const { world, stations } = twoIslands();
    const a = world.buildings[stations[0]];
    const b = world.buildings[stations[1]];

    // A wall of water from edge to edge: no route of any shape gets across.
    for (let y = 0; y < 128; y++) world.map.terrain[idx(40, y)] = Terrain.Water;
    const railBefore = world.map.rail.reduce((n, v) => n + v, 0);

    const { line } = createLineThrough(world, stations);

    expect(line).toBeNull();
    expect(world.map.rail.reduce((n, v) => n + v, 0)).toBe(railBefore);
    expect(findPath(world.rails, a.platform, b.platform)).toBeNull();
  });

  it('needs two stations', () => {
    const { world, stations } = twoIslands();
    expect(createLineThrough(world, [stations[0]]).line).toBeNull();
    expect(createLineThrough(world, []).line).toBeNull();
  });

  it('runs the new track through every station in the order they were picked', () => {
    const world = new World(11);
    world.map.terrain.fill(Terrain.Grass);

    const stations: BuildingId[] = [];
    for (const [x, y] of [[20, 20], [50, 20], [50, 60]] as const) {
      for (let k = -2; k <= 2; k++) world.placeRoad(idx(x + k, y));
      for (let k = -1; k <= 1; k++) world.placeRail(idx(x + k, y + 2));
      const b = world.placeStation(idx(x, y + 1));
      stations.push(b!.id);
    }

    const { line } = createLineThrough(world, stations);
    expect(line).not.toBeNull();

    // Every stop sits on the route, and the stops appear in the picked order
    // going out, mirrored coming back.
    expect(line!.stopStation.slice(0, 3)).toEqual(stations);
    for (let i = 0; i < line!.stopAt.length; i++) {
      const tile = line!.route[line!.stopAt[i]];
      const station = world.buildings[line!.stopStation[i]];
      expect(tile).toBe(station.platform);
    }
    // Track only ever runs orthogonally: no diagonal jumps in the route.
    for (let i = 1; i < line!.route.length; i++) {
      const step = Math.abs(tileX(line!.route[i]) - tileX(line!.route[i - 1]))
        + Math.abs(tileY(line!.route[i]) - tileY(line!.route[i - 1]));
      expect(step).toBe(1);
    }
  });
});

describe('stations without track', () => {
  /** Stations dropped on open ground beside a road, with no railway at all. */
  function trackless(): { world: World; stations: BuildingId[] } {
    const world = new World(3);
    world.map.terrain.fill(Terrain.Grass);
    for (let x = 10; x <= 70; x++) world.placeRoad(idx(x, 30));

    const stations: BuildingId[] = [];
    for (const x of [15, 40, 65]) {
      const b = world.placeStation(idx(x, 31));
      expect(b).not.toBeNull();
      expect(b!.platform).toBe(-1);
      stations.push(b!.id);
    }
    return { world, stations };
  }

  it('places a station on open ground beside a road', () => {
    const { world, stations } = trackless();
    expect(stations).toHaveLength(3);
    // ...but still not on a tile with no road at all.
    expect(world.placeStation(idx(100, 100))).toBeNull();
  });

  it('gives each one a platform and joins them when the line is built', () => {
    const { world, stations } = trackless();
    const { line, builtTrack } = createLineThrough(world, stations);

    expect(line).not.toBeNull();
    expect(builtTrack).toBe(true);
    for (const id of stations) {
      const station = world.buildings[id];
      expect(station.platform).toBeGreaterThanOrEqual(0);
      expect(world.map.isRail(station.platform)).toBe(true);
      // The platform is on the far side from the pavement, not on it.
      expect(station.platform).not.toBe(station.accessRoad);
    }
    expect(findPath(world.rails, world.buildings[stations[0]].platform,
      world.buildings[stations[2]].platform)).not.toBeNull();
  });

  it('lays no track at all when the line cannot be completed', () => {
    const { world, stations } = trackless();
    for (let y = 0; y < 128; y++) world.map.terrain[idx(50, y)] = Terrain.Water;
    // The road itself is gone under the water, so nothing can cross.
    world.bulldoze(idx(50, 30));

    const { line } = createLineThrough(world, stations);
    expect(line).toBeNull();
    expect(world.map.rail.reduce((n, v) => n + v, 0)).toBe(0);
    for (const id of stations) expect(world.buildings[id].platform).toBe(-1);
  });
});
