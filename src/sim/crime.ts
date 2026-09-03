import {
  CRIME_FROM_POVERTY,
  CRIME_PER_RESIDENT,
  CRIME_PER_SHOP,
  CRIME_SMOOTHING,
  CRIME_SPREAD,
  MAP_SIZE,
  POLICE_REACH,
  POLICE_RELIEF,
} from '../config';
import { idx, tileX, tileY } from '../core/grid';
import { BuildingType, Industry, type TileIndex } from '../core/types';
import { industryOf, isHome, isServing } from '../world/buildings';
import type { World } from '../world/world';
import type { LandValueField } from './landValue';

/**
 * How unsafe each tile feels, 0 (nothing ever happens here) to 100.
 *
 * A field rather than a per-building flag, because that is what crime is: a
 * property of a neighbourhood, felt by everyone in it including the people
 * who have not been burgled. It is fed by the two things that concentrate it
 * -- how many people are packed in, and how little the land is worth -- and
 * relieved by a police station within reach.
 *
 * It lands in three places: on how safe residents feel (happiness), on what
 * the land is worth, and on the odds of an actual incident at each address.
 * That last one closes the loop -- an offence nobody answered raises the crime
 * where it happened, which makes the next one likelier -- so a district left
 * to rot gets visibly worse rather than merely staying bad.
 */
/** How far the after-effects of one unanswered offence are felt. */
const PRESSURE_SPREAD = 3;

export class CrimeField {
  private readonly level = new Float32Array(MAP_SIZE * MAP_SIZE);

  update(world: World, landValue: LandValueField): void {
    const incoming = new Float32Array(MAP_SIZE * MAP_SIZE);

    for (const b of world.buildings) {
      if (!b.alive) continue;
      if (isHome(b.type)) {
        splat(incoming, b.tile, b.occupants.length * CRIME_PER_RESIDENT, CRIME_SPREAD);
      } else if (industryOf(b.type) === Industry.Retail) {
        // A parade of shops is where the trouble is, not where it comes from.
        splat(incoming, b.tile, CRIME_PER_SHOP, CRIME_SPREAD);
      }
    }

    for (const b of world.buildings) {
      if (b.type !== BuildingType.PoliceStation || !isServing(b)) continue;
      splat(incoming, b.tile, -POLICE_RELIEF, POLICE_REACH);
    }

    for (let tile = 0; tile < this.level.length; tile++) {
      // Cheap land is the other half of it, and the half the player can act
      // on without building anything: raise what a place is worth and the
      // crime that came with it goes away.
      const poverty = CRIME_FROM_POVERTY * Math.max(0, 1 - landValue.at(tile) / 60);
      const target = clamp(incoming[tile] + poverty);
      this.level[tile] += (target - this.level[tile]) * CRIME_SMOOTHING;
    }
  }

  at(tile: TileIndex): number {
    return tile >= 0 ? this.level[tile] : 0;
  }

  /** An offence that went unanswered leaves the street worse than it found it. */
  addPressure(tile: TileIndex, amount: number): void {
    if (tile < 0) return;
    splat(this.level, tile, amount, PRESSURE_SPREAD);
    // Clamp the disc that was just written rather than the whole field: this
    // runs per unsolved offence, and the other 16,000 tiles did not change.
    const cx = tileX(tile);
    const cy = tileY(tile);
    const y1 = Math.min(MAP_SIZE - 1, cy + PRESSURE_SPREAD);
    const x1 = Math.min(MAP_SIZE - 1, cx + PRESSURE_SPREAD);
    for (let y = Math.max(0, cy - PRESSURE_SPREAD); y <= y1; y++) {
      for (let x = Math.max(0, cx - PRESSURE_SPREAD); x <= x1; x++) {
        this.level[idx(x, y)] = Math.min(100, this.level[idx(x, y)]);
      }
    }
  }

  /** Mean over the tiles people actually live on, for the panel. */
  meanResidential(world: World): number {
    let sum = 0;
    let n = 0;
    for (const b of world.buildings) {
      if (!b.alive || !isHome(b.type)) continue;
      sum += this.at(b.tile);
      n++;
    }
    return n === 0 ? 0 : sum / n;
  }

  snapshot(): Float32Array {
    return this.level.slice();
  }

  restore(values: Float32Array): void {
    this.level.set(values.subarray(0, this.level.length));
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

function clamp(v: number): number {
  return Math.min(100, Math.max(0, v));
}
