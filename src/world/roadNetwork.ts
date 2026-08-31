import { MAP_SIZE } from '../config';
import { neighbor } from '../core/grid';
import { Direction, type TileIndex } from '../core/types';
import type { TileMap } from './tileMap';

/**
 * The road graph, with one node per road tile and edges to the four
 * neighbouring road tiles. 128^2 = 16384 nodes is small enough that A* over
 * raw tiles is fast, and it keeps placement trivially incremental: laying or
 * removing a road only rewrites that tile and its four neighbours.
 *
 * Adjacency is a bitmask per tile (bit i = DIRECTIONS[i] is a road), which
 * fits in the same flat Uint8Array style as the rest of the world.
 */
export class RoadNetwork {
  readonly adjacency = new Uint8Array(MAP_SIZE * MAP_SIZE);

  /** Bumped on every topology change, so path caches can invalidate cheaply. */
  version = 1;

  constructor(private readonly map: TileMap) {}

  /** Recompute the mask for `tile` and for each of its neighbours. */
  update(tile: TileIndex): void {
    this.recompute(tile);
    for (let dir = 0; dir < 4; dir++) {
      const n = neighbor(tile, dir as Direction);
      if (n >= 0) this.recompute(n);
    }
    this.version++;
  }

  private recompute(tile: TileIndex): void {
    if (!this.map.isRoad(tile)) {
      this.adjacency[tile] = 0;
      return;
    }
    let mask = 0;
    for (let dir = 0; dir < 4; dir++) {
      const n = neighbor(tile, dir as Direction);
      if (n >= 0 && this.map.isRoad(n)) mask |= 1 << dir;
    }
    this.adjacency[tile] = mask;
  }

  connects(tile: TileIndex, dir: Direction): boolean {
    return (this.adjacency[tile] & (1 << dir)) !== 0;
  }

  /** Rebuild every mask. Only used when loading a map wholesale. */
  rebuildAll(): void {
    for (let i = 0; i < this.adjacency.length; i++) this.recompute(i);
    this.version++;
  }
}
