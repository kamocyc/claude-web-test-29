import {
  MAP_SIZE,
  ORDINANCE_GREENING_AMENITY,
  PARK_AMENITY,
  PARK_REACH,
  VENUE_AMENITY,
  VENUE_REACH,
} from '../config';
import { idx, tileX, tileY } from '../core/grid';
import { BuildingType, Resource, type TileIndex } from '../core/types';
import type { World } from '../world/world';
import type { NoiseField } from './noise';
import type { CrimeField } from './crime';
import { Ordinance, type Policies } from './policies';
import { isLeisure } from '../world/buildings';

/** How far the pleasant things reach. */
const WATER_REACH = 6;
const STATION_REACH = 10;
const SHOP_REACH = 8;
const BUS_STOP_REACH = 5;

/**
 * What standing above the surrounding ground is worth.
 *
 * Capped, and worth nothing in a hollow: a tile in a dip is not *penalised*
 * for it, because the thing being priced is the view, and not having one is
 * the ordinary case rather than a defect.
 */
function viewBonus(prominence: number): number {
  return Math.min(3, Math.max(0, prominence)) * 5;
}

/**
 * What a point of crime takes off a tile's value.
 *
 * Slightly less than noise, and for a reason worth stating: noise is
 * permanent while the road or the factory is there, and crime is not -- a
 * police station takes it away again. Weighting them the same would make a
 * bad district unrecoverable.
 */
const CRIME_WEIGHT = 0.45;

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
/**
 * Why a tile is worth what it is: the same terms `update` sums, kept apart so
 * the panel can show the player which of their decisions moved the number.
 *
 * Every field is in land-value points, and they add up: `base` plus the
 * amenities, minus the noise and the crime, is the value the tile is heading
 * towards.
 */
export interface LandValueFactors {
  /** What bare, unimproved, quiet ground is worth. */
  base: number;
  /** Being near open water. */
  water: number;
  /** Standing on wooded ground. */
  greenery: number;
  /** Standing above the ground around it: a view, and away from the traffic. */
  view: number;
  /** Being within walking distance of a station. */
  station: number;
  /** ...of shops. */
  shops: number;
  /** ...of offices. */
  offices: number;
  /** Being near a park or one of the big leisure venues. */
  parks: number;
  /** Traffic, industry and railways. Negative: noise takes value away. */
  noise: number;
  /** What the neighbourhood's crime takes off it. Negative, like the noise. */
  crime: number;
  /** Where the tile is heading: base + amenities - noise, clamped to 0..100. */
  target: number;
  /** Where it is now. Land value moves slowly, so the two differ. */
  current: number;
}

export class LandValueField {
  private readonly value = new Float32Array(MAP_SIZE * MAP_SIZE).fill(40);

  update(world: World, noise: NoiseField, crime: CrimeField, policies?: Policies): void {
    const green = greeningFactor(policies);
    const amenity = new Float32Array(MAP_SIZE * MAP_SIZE);

    // Nature, from the map itself.
    for (let tile = 0; tile < amenity.length; tile++) {
      if (world.map.isWater(tile)) spread(amenity, tile, 10, WATER_REACH);
      else if (world.map.getResource(tile) === Resource.Forest) amenity[tile] += 6;
      // Higher ground than its surroundings: a view, and above the noise of
      // whatever is going on in the valley. This is what stops the hills
      // being purely an obstacle -- the awkward land is also the good land.
      amenity[tile] += viewBonus(world.map.prominence[tile]);
    }

    // Services, from what has been built.
    for (const b of world.buildings) {
      if (!b.alive) continue;
      if (b.type === BuildingType.Station) spread(amenity, b.tile, 22, STATION_REACH);
      else if (b.type === BuildingType.Shop) spread(amenity, b.tile, 8, SHOP_REACH);
      else if (b.type === BuildingType.Office) spread(amenity, b.tile, 4, SHOP_REACH);
      // A bus stop is worth having nearby, and worth much less than a station:
      // it is a pole on a road that was already there.
      else if (b.type === BuildingType.BusStop) spread(amenity, b.tile, 6, BUS_STOP_REACH);
      // A park is the strongest thing per tile the player can put down, over
      // the smallest radius: it cannot rescue a district, but it can rescue
      // the block between the housing and whatever is spoiling it.
      else if (isLeisure(b.type)) {
        const [amount, reach] = leisureAmenity(b.type);
        spread(amenity, b.tile, amount * green, reach);
      }
    }

    for (let tile = 0; tile < this.value.length; tile++) {
      const target = clamp(
        40 + amenity[tile] - noise.at(tile) * 0.6 - crime.at(tile) * CRIME_WEIGHT,
      );
      // Land value moves slowly: it is a reputation, not a measurement.
      this.value[tile] += (target - this.value[tile]) * 0.25;
    }
  }

  at(tile: TileIndex): number {
    return tile >= 0 ? this.value[tile] : 0;
  }

  /**
   * The breakdown for one tile, recomputed from the same sources and the same
   * falloff `update` uses -- so what the panel says raised a tile's value is
   * exactly what did raise it, rather than a second model that can drift.
   *
   * Recomputed on demand rather than stored: this runs for the one tile the
   * player has clicked on, where a per-tile record for all 65,536 tiles times
   * seven factors would be paid for on every field update.
   */
  factorsAt(
    world: World,
    noise: NoiseField,
    crime: CrimeField,
    tile: TileIndex,
    policies?: Policies,
  ): LandValueFactors {
    const green = greeningFactor(policies);
    let water = 0;
    for (const near of within(tile, WATER_REACH)) {
      if (world.map.isWater(near)) water += 10 * falloff(tile, near, WATER_REACH);
    }
    const greenery = world.map.getResource(tile) === Resource.Forest ? 6 : 0;
    const view = viewBonus(world.map.prominence[tile]);

    let station = 0;
    let shops = 0;
    let offices = 0;
    let parks = 0;
    for (const b of world.buildings) {
      if (!b.alive) continue;
      if (b.type === BuildingType.Station) {
        station += 22 * falloff(tile, b.tile, STATION_REACH);
      } else if (b.type === BuildingType.Shop) {
        shops += 8 * falloff(tile, b.tile, SHOP_REACH);
      } else if (b.type === BuildingType.Office) {
        offices += 4 * falloff(tile, b.tile, SHOP_REACH);
      } else if (b.type === BuildingType.BusStop) {
        station += 6 * falloff(tile, b.tile, BUS_STOP_REACH);
      } else if (isLeisure(b.type)) {
        const [amount, reach] = leisureAmenity(b.type);
        parks += amount * green * falloff(tile, b.tile, reach);
      }
    }

    const penalty = noise.at(tile) * 0.6;
    const unsafe = crime.at(tile) * CRIME_WEIGHT;
    return {
      base: 40,
      water,
      greenery,
      view,
      station,
      shops,
      offices,
      parks,
      noise: -penalty,
      crime: -unsafe,
      target: clamp(
        40 + water + greenery + view + station + shops + offices + parks
        - penalty - unsafe,
      ),
      current: this.at(tile),
    };
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

/** What one leisure venue is worth to the ground, and how far it carries. */
function leisureAmenity(type: BuildingType): [number, number] {
  return type === BuildingType.Park
    ? [PARK_AMENITY, PARK_REACH]
    : [VENUE_AMENITY, VENUE_REACH];
}

/** The greening by-law, in the one place both the field and the panel read. */
function greeningFactor(policies?: Policies): number {
  return policies?.isOn(Ordinance.Greening) ? ORDINANCE_GREENING_AMENITY : 1;
}

/** The tiles within `radius` of `tile`, the disc `spread` writes into. */
function* within(tile: TileIndex, radius: number): Generator<TileIndex> {
  const cx = tileX(tile);
  const cy = tileY(tile);
  for (let y = Math.max(0, cy - radius); y <= Math.min(MAP_SIZE - 1, cy + radius); y++) {
    for (let x = Math.max(0, cx - radius); x <= Math.min(MAP_SIZE - 1, cx + radius); x++) {
      if (Math.hypot(x - cx, y - cy) <= radius) yield idx(x, y);
    }
  }
}

/** The share of a source's strength that reaches `tile`, 0 outside the disc. */
function falloff(tile: TileIndex, source: TileIndex, radius: number): number {
  const d = Math.hypot(tileX(tile) - tileX(source), tileY(tile) - tileY(source));
  return d > radius ? 0 : 1 - d / (radius + 1);
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
