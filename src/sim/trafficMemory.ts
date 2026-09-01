import { CAR_FREE_SPEED, MAP_SIZE } from '../config';
import type { TileIndex } from '../core/types';
import type { Occupancy } from './occupancy';
import type { World } from '../world/world';

/** How fast the remembered speed follows what is happening now. */
const SMOOTHING = 0.01;
/** How fast a quiet tile forgets a jam and returns to free flow. */
const RECOVERY = 0.004;
/** Nobody plans a route assuming a road is *completely* stopped. */
const MIN_RATIO = 0.15;

/**
 * A per-tile memory of how fast traffic has actually been moving, used to
 * price a driving route.
 *
 * This is what makes the train worth catching. Estimating a drive at free flow
 * makes rail structurally pointless -- a car is door to door, so it wins every
 * comparison and no line ever fills. Pricing the drive at the speed the road
 * has really been running means the mode choice moves with the day: at 3am the
 * roads are empty and everyone drives; by 8am the arterials are remembered as
 * slow and the same citizens take the train instead.
 *
 * It is a memory rather than an instantaneous reading on purpose. A commuter
 * knows what their route is normally like at this hour; they cannot see the
 * jam that is forming while they put their coat on.
 */
export class TrafficMemory {
  private readonly ratio = new Float32Array(MAP_SIZE * MAP_SIZE).fill(1);
  /** Tiles currently below free flow, so recovery need not scan the map. */
  private tracked: TileIndex[] = [];

  update(world: World, occupancy: Occupancy): void {
    const seen = new Set<TileIndex>();

    for (const tile of occupancy.dirtyTiles) {
      const cars = occupancy.at(tile);
      if (cars.length === 0) continue;

      let sum = 0;
      for (const car of cars) {
        const c = world.citizens[car.id];
        if (c) sum += c.v / CAR_FREE_SPEED;
      }
      const observed = Math.max(MIN_RATIO, sum / cars.length);
      this.blend(tile, observed, SMOOTHING);
      seen.add(tile);
    }

    // Tiles nobody drove on this tick drift back towards free flow.
    const stillSlow: TileIndex[] = [];
    for (const tile of this.tracked) {
      if (seen.has(tile)) {
        stillSlow.push(tile);
        continue;
      }
      this.ratio[tile] += (1 - this.ratio[tile]) * RECOVERY;
      if (this.ratio[tile] < 0.995) stillSlow.push(tile);
      else this.ratio[tile] = 1;
    }
    this.tracked = stillSlow;
  }

  private blend(tile: TileIndex, observed: number, rate: number): void {
    const before = this.ratio[tile];
    this.ratio[tile] = before + (observed - before) * rate;
    if (before >= 1 && this.ratio[tile] < 1) this.tracked.push(tile);
  }

  speedRatio(tile: TileIndex): number {
    return this.ratio[tile];
  }

  /** Ticks to drive a door-to-door path at remembered speeds. */
  driveTicks(path: readonly TileIndex[]): number {
    let ticks = 0;
    for (let i = 0; i < path.length - 1; i++) {
      ticks += 1 / (CAR_FREE_SPEED * Math.max(MIN_RATIO, this.ratio[path[i]]));
    }
    return ticks;
  }
}
