import { describe, expect, it } from 'vitest';
import { idx } from '../core/grid';
import { findPath, PathCache } from '../sim/pathfinding';
import { World } from '../world/world';

function flatWorld(): World {
  const w = new World(3);
  w.map.terrain.fill(0);
  return w;
}

/** Straight corridor along y=5 from x=2 to x=12. */
function corridor(w: World): void {
  for (let x = 2; x <= 12; x++) w.placeRoad(idx(x, 5));
}

describe('pathfinding', () => {
  it('finds the shortest path down a corridor', () => {
    const w = flatWorld();
    corridor(w);
    const path = findPath(w.roads, idx(2, 5), idx(12, 5));
    expect(path).not.toBeNull();
    expect(path).toHaveLength(11);
    expect(path![0]).toBe(idx(2, 5));
    expect(path![path!.length - 1]).toBe(idx(12, 5));
  });

  it('routes around a gap using the only detour available', () => {
    const w = flatWorld();
    // Two parallel corridors joined at both ends; break the direct one so the
    // route has to take the longer branch.
    for (let x = 2; x <= 8; x++) {
      w.placeRoad(idx(x, 5));
      w.placeRoad(idx(x, 8));
    }
    for (let y = 5; y <= 8; y++) {
      w.placeRoad(idx(2, y));
      w.placeRoad(idx(8, y));
    }
    w.bulldoze(idx(5, 5));

    const path = findPath(w.roads, idx(4, 5), idx(6, 5));
    expect(path).not.toBeNull();
    // Down, across, and back up rather than the severed two-step hop.
    expect(path!.length).toBeGreaterThan(3);
    expect(path).not.toContain(idx(5, 5));
  });

  it('returns null when the destination is unreachable', () => {
    const w = flatWorld();
    corridor(w);
    w.placeRoad(idx(40, 40));
    expect(findPath(w.roads, idx(2, 5), idx(40, 40))).toBeNull();
  });

  it('returns null for non-road endpoints', () => {
    const w = flatWorld();
    corridor(w);
    expect(findPath(w.roads, idx(2, 5), idx(2, 20))).toBeNull();
  });

  it('returns a single-tile path when start equals goal', () => {
    const w = flatWorld();
    corridor(w);
    expect(findPath(w.roads, idx(5, 5), idx(5, 5))).toEqual([idx(5, 5)]);
  });

  it('caches results and invalidates them when the road graph changes', () => {
    const w = flatWorld();
    corridor(w);
    const cache = new PathCache();
    const compute = () => findPath(w.roads, idx(2, 5), idx(12, 5));

    const first = cache.get(w.roads, 'a', compute);
    const second = cache.get(w.roads, 'a', compute);
    expect(cache.hits).toBe(1);
    expect(second).toBe(first);

    w.bulldoze(idx(7, 5));
    const third = cache.get(w.roads, 'a', compute);
    expect(cache.misses).toBe(2);
    expect(third).toBeNull();
  });
});
