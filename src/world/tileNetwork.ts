import { MAP_SIZE } from '../config';
import { neighbor } from '../core/grid';
import { Direction, type TileIndex } from '../core/types';

/**
 * A 4-connected graph over one tile layer, with one node per occupied tile.
 *
 * 128^2 = 16384 nodes is small enough that A* over raw tiles is fast, and it
 * keeps placement trivially incremental: laying or removing a tile only
 * rewrites that tile and its four neighbours.
 *
 * Adjacency is a bitmask per tile (bit i = DIRECTIONS[i] is also occupied).
 * Roads and rails are the same structure over different layers, so both get
 * incremental updates, version-based cache invalidation and A* for free.
 */
export class TileNetwork {
  readonly adjacency = new Uint8Array(MAP_SIZE * MAP_SIZE);

  /** Bumped on every topology change, so path caches can invalidate cheaply. */
  version = 1;

  constructor(private readonly occupied: (tile: TileIndex) => boolean) {}

  has(tile: TileIndex): boolean {
    return tile >= 0 && this.occupied(tile);
  }

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
    if (!this.occupied(tile)) {
      this.adjacency[tile] = 0;
      return;
    }
    let mask = 0;
    for (let dir = 0; dir < 4; dir++) {
      const n = neighbor(tile, dir as Direction);
      if (n >= 0 && this.occupied(n)) mask |= 1 << dir;
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
