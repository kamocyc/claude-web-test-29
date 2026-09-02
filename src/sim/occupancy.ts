import { MAP_SIZE } from '../config';
import { Direction, type TileIndex } from '../core/types';

export interface Occupant {
  /** Identity only, for excluding a vehicle from its own leader search. */
  id: number;
  dir: Direction;
  /** How far into the tile the vehicle is, 0 at entry, 1 at exit. */
  progress: number;
  /**
   * Current speed as a fraction of this vehicle's own free speed.
   *
   * Carried here rather than looked up, because the two things that want it --
   * the traffic overlay and the remembered congestion -- used to reach back
   * into `world.citizens[occupant.id]` for it. That only worked while every
   * occupant *was* a citizen; a lorry in the same queue would have silently
   * read a stranger's speed. Publishing the number with the position keeps
   * the occupancy snapshot self-contained.
   */
  speedRatio: number;
  /** Road space taken, as a multiple of a car. A lorry is worth about 2.3. */
  size: number;
}

/**
 * Which cars are on which road tile, rebuilt from scratch every tick.
 *
 * Rebuilding is cheaper than it sounds (a few hundred pushes) and removes a
 * whole class of bugs: incremental registration leaks entries whenever a car
 * crosses a tile boundary, is removed mid-trip, or is re-routed. It also makes
 * the tick order-independent, which the determinism test depends on.
 */
export class Occupancy {
  private readonly tiles: (Occupant[] | undefined)[] = new Array(MAP_SIZE * MAP_SIZE);
  private dirty: TileIndex[] = [];

  clear(): void {
    for (const t of this.dirty) {
      const list = this.tiles[t];
      if (list) list.length = 0;
    }
    this.dirty.length = 0;
  }

  add(tile: TileIndex, occ: Occupant): void {
    let list = this.tiles[tile];
    if (!list) {
      list = [];
      this.tiles[tile] = list;
    }
    if (list.length === 0) this.dirty.push(tile);
    list.push(occ);
  }

  at(tile: TileIndex): readonly Occupant[] {
    return this.tiles[tile] ?? EMPTY;
  }

  /** Tiles holding at least one car this tick. */
  get dirtyTiles(): readonly TileIndex[] {
    return this.dirty;
  }

  /**
   * Road space blocking entry to a tile: same heading (a queue ahead of us)
   * and perpendicular headings (crossing traffic we must yield to). The
   * opposing direction is excluded -- those are in the other lane and would
   * otherwise make every two-way road deadlock.
   *
   * Measured in car-equivalents rather than in vehicles, so a lorry takes the
   * room it actually needs. With cars alone this is exactly the old count.
   */
  blockingCount(tile: TileIndex, dir: Direction): number {
    const list = this.tiles[tile];
    if (!list) return 0;
    const opposite = (dir + 2) % 4;
    let n = 0;
    for (const o of list) {
      if (o.dir !== opposite) n += o.size;
    }
    return n;
  }

  /** Total road space in use on a tile, for the noise the traffic makes. */
  loadAt(tile: TileIndex): number {
    const list = this.tiles[tile];
    if (!list) return 0;
    let total = 0;
    for (const o of list) total += o.size;
    return total;
  }

  /** Mean speed ratio of the vehicles on a tile, or -1 when it is empty. */
  meanSpeedRatio(tile: TileIndex): number {
    const list = this.tiles[tile];
    if (!list || list.length === 0) return -1;
    let sum = 0;
    for (const o of list) sum += o.speedRatio;
    return sum / list.length;
  }

  /**
   * Distance to the car ahead within this tile, or Infinity if the lane is
   * clear. `progress` is the caller's own position within the tile.
   */
  gapAheadInTile(tile: TileIndex, dir: Direction, progress: number, selfId: number): number {
    const list = this.tiles[tile];
    if (!list) return Infinity;
    let best = Infinity;
    for (const o of list) {
      if (o.id === selfId || o.dir !== dir) continue;
      const d = o.progress - progress;
      if (d > 0 && d < best) best = d;
    }
    return best;
  }

  /**
   * Distance from the entry of `tile` to the nearest blocking car inside it,
   * for a driver about to enter heading `dir`.
   *
   * `ignoreCrossing` is the deadlock escape: two queues meeting at an
   * intersection can each hold the other's lead car stationary forever, since
   * neither is over the tile capacity -- they are simply in each other's way.
   * A car that has waited long enough stops yielding to crossing traffic.
   * Same-direction cars are still respected, so the no-collision guarantee
   * within a lane is never given up.
   */
  gapIntoTile(tile: TileIndex, dir: Direction, ignoreCrossing = false): number {
    const list = this.tiles[tile];
    if (!list) return Infinity;
    const opposite = (dir + 2) % 4;
    let best = Infinity;
    for (const o of list) {
      if (o.dir === opposite) continue;
      if (o.dir !== dir) {
        if (ignoreCrossing) continue;
        // Crossing traffic sits mid-tile regardless of its own progress.
        if (0.5 < best) best = 0.5;
        continue;
      }
      if (o.progress < best) best = o.progress;
    }
    return best;
  }
}

const EMPTY: readonly Occupant[] = [];
