import { MAP_SIZE, NOISE_SMOOTHING, TRAFFIC_NOISE_PER_CAR } from '../config';
import { idx, tileX, tileY } from '../core/grid';
import type { TileIndex } from '../core/types';
import { operatingRatio, specFor } from '../world/buildings';
import type { World } from '../world/world';
import type { Occupancy } from './occupancy';

/** How far a source is heard, and how much of it survives the distance. */
const SPREAD = 5;

/**
 * How loud each tile is, from 0 (quiet) to 100 (unliveable).
 *
 * Noise is the one field in the sim that ties the two halves of the city
 * together: it comes out of the traffic model and the industry model, and it
 * lands on land value and on how the residents feel. That is why it is worth
 * having as a real field rather than as a penalty attached to building types --
 * an arterial road is only noisy where the traffic actually is, so the same
 * factory is a different neighbour depending on how the player routed the
 * lorries past it.
 *
 * It is smoothed over time rather than recomputed outright. Traffic noise is
 * measured from cars that happened to be on a tile at one instant, which is far
 * too spiky to price land with; blending it in slowly gives "how loud this
 * place usually is", which is what someone deciding where to live would know.
 */
export class NoiseField {
  private readonly level = new Float32Array(MAP_SIZE * MAP_SIZE);
  /** Cars seen per road tile since the last recompute. */
  private readonly traffic = new Float32Array(MAP_SIZE * MAP_SIZE);
  private samples = 0;

  /** Cheap per-tick tally, so the expensive part can run rarely. */
  sample(occupancy: Occupancy): void {
    for (const tile of occupancy.dirtyTiles) {
      // Road space, not vehicle count: a lorry is louder than a hatchback,
      // and it is the same number that decides how much room it takes up.
      this.traffic[tile] += occupancy.loadAt(tile);
    }
    this.samples++;
  }

  /** Rebuild the field from the tally and the noisy buildings. */
  update(world: World): void {
    const incoming = new Float32Array(MAP_SIZE * MAP_SIZE);
    const perSample = this.samples > 0 ? 1 / this.samples : 0;

    for (let tile = 0; tile < this.traffic.length; tile++) {
      const cars = this.traffic[tile] * perSample;
      if (cars > 0) splat(incoming, tile, cars * TRAFFIC_NOISE_PER_CAR, 3);
      this.traffic[tile] = 0;
    }
    this.samples = 0;

    for (const b of world.buildings) {
      if (!b.alive) continue;
      const emitted = specFor(b.type).noise;
      if (emitted <= 0) continue;

      // A shut factory is a quiet factory -- but never silent, since the site
      // itself is still there. Stations have no staff and are always working.
      const spec = specFor(b.type);
      const running = spec.capacity === 0 ? 1 : Math.max(0.25, operatingRatio(b));
      splat(incoming, b.tile, emitted * running * 4, SPREAD);
    }

    for (let i = 0; i < this.level.length; i++) {
      const target = Math.min(100, incoming[i]);
      this.level[i] += (target - this.level[i]) * NOISE_SMOOTHING;
    }
  }

  at(tile: TileIndex): number {
    return tile >= 0 ? this.level[tile] : 0;
  }

  snapshot(): Float32Array {
    return this.level.slice();
  }

  restore(values: Float32Array): void {
    this.level.set(values.subarray(0, this.level.length));
  }

  /**
   * The part-finished tally, and how many ticks are in it.
   *
   * Saved along with the field because it cannot be recomputed: it is a
   * measurement of cars that were on the road between the last recompute and
   * now, and those cars have been and gone. A load that dropped it would run
   * the next hourly update on a fraction of an hour's traffic, which is a
   * quieter city than the one that was saved -- and quiet enough, through
   * land value and health, for the whole city to drift.
   */
  snapshotTally(): { traffic: Float32Array; samples: number } {
    return { traffic: this.traffic.slice(), samples: this.samples };
  }

  restoreTally(traffic: Float32Array, samples: number): void {
    this.traffic.set(traffic.subarray(0, this.traffic.length));
    this.samples = samples;
  }
}

/** Add a source, falling off linearly with distance. */
function splat(field: Float32Array, tile: TileIndex, amount: number, radius: number): void {
  const cx = tileX(tile);
  const cy = tileY(tile);
  const x0 = Math.max(0, cx - radius);
  const x1 = Math.min(MAP_SIZE - 1, cx + radius);
  const y0 = Math.max(0, cy - radius);
  const y1 = Math.min(MAP_SIZE - 1, cy + radius);

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > radius) continue;
      field[idx(x, y)] += amount * (1 - d / (radius + 1));
    }
  }
}
