import { PATH_CACHE_SIZE } from '../config';
import { manhattan, neighbor } from '../core/grid';
import { Direction, type TileIndex } from '../core/types';
import type { RoadNetwork } from '../world/roadNetwork';
import type { TileMap } from '../world/tileMap';

/**
 * A* over road tiles. Costs are free-flow only -- congestion is deliberately
 * left out so that routes stay cacheable and citizens can actually get stuck
 * in the jams the player creates, which is the point of watching them.
 */
export function findRoadPath(
  map: TileMap,
  roads: RoadNetwork,
  start: TileIndex,
  goal: TileIndex,
): TileIndex[] | null {
  if (start < 0 || goal < 0) return null;
  if (!map.isRoad(start) || !map.isRoad(goal)) return null;
  if (start === goal) return [start];

  const open: TileIndex[] = [start];
  const gScore = new Map<TileIndex, number>([[start, 0]]);
  const fScore = new Map<TileIndex, number>([[start, manhattan(start, goal)]]);
  const cameFrom = new Map<TileIndex, TileIndex>();
  const closed = new Set<TileIndex>();

  while (open.length > 0) {
    // Linear scan for the best node. The frontier stays small on a road grid,
    // and this avoids a heap allocation per search.
    let bestAt = 0;
    let bestF = Infinity;
    for (let i = 0; i < open.length; i++) {
      const f = fScore.get(open[i]) ?? Infinity;
      if (f < bestF) {
        bestF = f;
        bestAt = i;
      }
    }
    const current = open[bestAt];
    if (current === goal) return reconstruct(cameFrom, current);

    open[bestAt] = open[open.length - 1];
    open.pop();
    closed.add(current);

    const g = gScore.get(current) ?? Infinity;
    for (let dir = 0; dir < 4; dir++) {
      if (!roads.connects(current, dir as Direction)) continue;
      const next = neighbor(current, dir as Direction);
      if (next < 0 || closed.has(next)) continue;

      const tentative = g + 1;
      if (tentative < (gScore.get(next) ?? Infinity)) {
        cameFrom.set(next, current);
        gScore.set(next, tentative);
        fScore.set(next, tentative + manhattan(next, goal));
        if (!open.includes(next)) open.push(next);
      }
    }
  }
  return null;
}

function reconstruct(cameFrom: Map<TileIndex, TileIndex>, end: TileIndex): TileIndex[] {
  const path = [end];
  let cur = end;
  while (cameFrom.has(cur)) {
    cur = cameFrom.get(cur)!;
    path.push(cur);
  }
  path.reverse();
  return path;
}

/**
 * Home<->work round trips dominate, so a plain insertion-ordered Map used as
 * an LRU gets a very high hit rate. The whole cache is dropped when the road
 * graph changes: partial invalidation is not worth the bookkeeping.
 */
export class PathCache {
  private entries = new Map<string, TileIndex[] | null>();
  private version = -1;

  hits = 0;
  misses = 0;

  get(
    roads: RoadNetwork,
    key: string,
    compute: () => TileIndex[] | null,
  ): TileIndex[] | null {
    if (this.version !== roads.version) {
      this.entries.clear();
      this.version = roads.version;
    }

    if (this.entries.has(key)) {
      const hit = this.entries.get(key)!;
      // Refresh recency.
      this.entries.delete(key);
      this.entries.set(key, hit);
      this.hits++;
      return hit;
    }

    this.misses++;
    const value = compute();
    if (this.entries.size >= PATH_CACHE_SIZE) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, value);
    return value;
  }

  get size(): number {
    return this.entries.size;
  }
}
