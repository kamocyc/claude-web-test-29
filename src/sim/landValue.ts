import { MAP_SIZE } from '../config';
import { idx, tileX, tileY } from '../core/grid';
import { BuildingType, Resource, type TileIndex } from '../core/types';
import type { World } from '../world/world';
import type { NoiseField } from './noise';

/** How far the pleasant things reach. */
const WATER_REACH = 6;
const STATION_REACH = 10;
const SHOP_REACH = 8;

/**
 * What a tile is worth to live on, 0..100.
 *
 * Land value is not an input the player sets; it is the sum of everything else
 * they have done. Water and greenery raise it, a station or shops within
 * walking distance raise it, noise and heavy industry sink it. It then feeds
 * back into the city in two places -- flats will not be built on cheap land,
 * and residents on cheap land are less happy -- which is what makes an
 * industrial estate next to the housing a mistake the player can watch unfold
 * rather than a rule they are told about.
 */
export class LandValueField {
  private readonly value = new Float32Array(MAP_SIZE * MAP_SIZE).fill(40);

  update(world: World, noise: NoiseField): void {
    const amenity = new Float32Array(MAP_SIZE * MAP_SIZE);

    // Nature, from the map itself.
    for (let tile = 0; tile < amenity.length; tile++) {
      if (world.map.isWater(tile)) spread(amenity, tile, 10, WATER_REACH);
      else if (world.map.getResource(tile) === Resource.Forest) amenity[tile] += 6;
    }

    // Services, from what has been built.
    for (const b of world.buildings) {
      if (!b.alive) continue;
      if (b.type === BuildingType.Station) spread(amenity, b.tile, 22, STATION_REACH);
      else if (b.type === BuildingType.Shop) spread(amenity, b.tile, 8, SHOP_REACH);
      else if (b.type === BuildingType.Office) spread(amenity, b.tile, 4, SHOP_REACH);
    }

    for (let tile = 0; tile < this.value.length; tile++) {
      const target = clamp(40 + amenity[tile] - noise.at(tile) * 0.6);
      // Land value moves slowly: it is a reputation, not a measurement.
      this.value[tile] += (target - this.value[tile]) * 0.25;
    }
  }

  at(tile: TileIndex): number {
    return tile >= 0 ? this.value[tile] : 0;
  }

  /** Mean value over the tiles people actually live on. */
  meanResidential(world: World): number {
    let sum = 0;
    let n = 0;
    for (const b of world.buildings) {
      if (!b.alive) continue;
      if (b.type !== BuildingType.House && b.type !== BuildingType.Apartment) continue;
      sum += this.at(b.tile);
      n++;
    }
    return n === 0 ? 0 : sum / n;
  }

  snapshot(): Float32Array {
    return this.value.slice();
  }

  restore(values: Float32Array): void {
    this.value.set(values.subarray(0, this.value.length));
  }
}

function spread(field: Float32Array, tile: TileIndex, amount: number, radius: number): void {
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

function clamp(v: number): number {
  return Math.min(100, Math.max(0, v));
}
