import { CROSSING_WARN_TILES, MAP_SIZE } from '../config';
import type { TileIndex } from '../core/types';
import type { World } from '../world/world';

/**
 * Which level crossings are currently closed to road traffic.
 *
 * Trains have absolute priority and never look at the road; the barrier is
 * modelled entirely on the car side, as a stop point at the tile boundary.
 * The set is rebuilt each tick by walking a short way ahead of every train,
 * which is a handful of steps per train rather than a scan of the map.
 */
export class Crossings {
  private readonly closed = new Uint8Array(MAP_SIZE * MAP_SIZE);
  private touched: TileIndex[] = [];

  update(world: World): void {
    for (const tile of this.touched) this.closed[tile] = 0;
    this.touched.length = 0;

    for (const train of world.trains) {
      const line = world.lines[train.line];
      if (!line || !world.lineIsAlive(line)) continue;

      const lap = line.route.length - 1;
      const from = Math.floor(train.s);
      for (let step = 0; step <= CROSSING_WARN_TILES; step++) {
        let at = from + step;
        if (at >= lap) at -= lap;
        this.close(world, line.route[at]);
      }
    }
  }

  private close(world: World, tile: TileIndex): void {
    if (tile === undefined || !world.map.isCrossing(tile)) return;
    if (this.closed[tile] === 1) return;
    this.closed[tile] = 1;
    this.touched.push(tile);
  }

  isClosed(tile: TileIndex): boolean {
    return tile >= 0 && this.closed[tile] === 1;
  }

  get closedTiles(): readonly TileIndex[] {
    return this.touched;
  }
}
