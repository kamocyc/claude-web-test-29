import { describe, expect, it } from 'vitest';
import { idx } from '../core/grid';
import { Direction } from '../core/types';
import { World } from '../world/world';

function flatWorld(): World {
  const w = new World(7);
  w.map.terrain.fill(0); // drop the river so tests are about roads only
  return w;
}

describe('roadNetwork', () => {
  it('links neighbouring road tiles in both directions', () => {
    const w = flatWorld();
    w.placeRoad(idx(10, 10));
    w.placeRoad(idx(11, 10));

    expect(w.roads.connects(idx(10, 10), Direction.East)).toBe(true);
    expect(w.roads.connects(idx(11, 10), Direction.West)).toBe(true);
    expect(w.roads.connects(idx(10, 10), Direction.North)).toBe(false);
  });

  it('updates only the placed tile and its neighbours', () => {
    const w = flatWorld();
    w.placeRoad(idx(5, 5));
    expect(w.roads.adjacency[idx(5, 5)]).toBe(0);

    w.placeRoad(idx(6, 5));
    expect(w.roads.connects(idx(5, 5), Direction.East)).toBe(true);
    // A tile two steps away is untouched.
    expect(w.roads.adjacency[idx(8, 5)]).toBe(0);
  });

  it('severs adjacency when a road is bulldozed', () => {
    const w = flatWorld();
    for (let x = 0; x < 4; x++) w.placeRoad(idx(x, 3));
    expect(w.roads.connects(idx(1, 3), Direction.East)).toBe(true);

    w.bulldoze(idx(2, 3));
    expect(w.roads.connects(idx(1, 3), Direction.East)).toBe(false);
    expect(w.roads.connects(idx(3, 3), Direction.West)).toBe(false);
    expect(w.roads.adjacency[idx(2, 3)]).toBe(0);
  });

  it('bumps the version on every topology change', () => {
    const w = flatWorld();
    const before = w.roads.version;
    w.placeRoad(idx(20, 20));
    expect(w.roads.version).toBeGreaterThan(before);

    const mid = w.roads.version;
    w.bulldoze(idx(20, 20));
    expect(w.roads.version).toBeGreaterThan(mid);
  });

  it('refuses to build roads on water', () => {
    const w = flatWorld();
    w.map.terrain[idx(9, 9)] = 1;
    expect(w.placeRoad(idx(9, 9))).toBe(false);
  });

  it('rebuildAll reproduces the incremental result', () => {
    const w = flatWorld();
    for (let x = 2; x < 9; x++) w.placeRoad(idx(x, 4));
    for (let y = 2; y < 9; y++) w.placeRoad(idx(5, y));
    const incremental = Uint8Array.from(w.roads.adjacency);

    w.roads.rebuildAll();
    expect(Array.from(w.roads.adjacency)).toEqual(Array.from(incremental));
  });
});
