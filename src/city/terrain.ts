import { createNoise2D } from 'simplex-noise';
import { MAP_SIZE } from '../track/core/units';
import { mulberry32 } from '../track/terrain/generator';
import type { Heightfield } from '../track/terrain/heightfield';

/**
 * The ground the city is built on, and what it is good for.
 *
 * The ported engine's terrain is a pure heightfield: hills, a valley, and
 * nothing that says what a place is *for*. The city needs two more facts about
 * the same ground, and both are kept here rather than pushed into the engine,
 * so the engine stays the thing it is and can still be compared against the
 * repository it came from.
 *
 *   water     -- everything below the water level is river or lake. The engine
 *                already carries a road over low ground as a bridge, so water
 *                needs no geometry of its own; what it needs is to be *known*,
 *                so nothing is built in it and the map draws it as water.
 *   resources -- fertile ground, woods and ore seams, in world space. Primary
 *                industry can only be zoned where the ground supports it,
 *                which is what stops a map from being a uniform sheet of
 *                interchangeable land.
 */

/** Ground below this height is water. The valley floor sits under it. */
export const WATER_LEVEL = -14;

/** What a patch of ground is naturally good for. */
export const enum Resource {
  None = 0,
  /** Fertile ground along the valley: paddy fields. */
  Fertile = 1,
  Forest = 2,
  Ore = 3,
}

/**
 * The resource grid's cell size [m].
 *
 * Coarser than the terrain (4 m) and than the zoning paint grid (4 m): a seam
 * is a *place*, tens of metres across, and storing it per terrain cell would
 * be four hundred thousand cells to say something that changes every twenty.
 */
export const RESOURCE_CELL = 20;
const RESOURCE_CELLS = Math.ceil(MAP_SIZE / RESOURCE_CELL);

export class CityTerrain {
  /** One entry per resource cell, indexed like the heightfield's grid. */
  private readonly resources = new Uint8Array(RESOURCE_CELLS * RESOURCE_CELLS);

  constructor(readonly field: Heightfield) {}

  /**
   * Scatter the deposits.
   *
   * Each kind wants a different relationship to the map, exactly as in the
   * tile city this replaces: the fertile ground follows the low land (that is
   * what makes it fertile), the woods want to be somewhere the city has to
   * reach out to, and the ore wants to be in a few concentrated seams so that
   * mining is a place rather than an option available everywhere.
   */
  generate(seed: number): void {
    this.resources.fill(Resource.None);
    const rand = mulberry32(seed ^ 0x5eed);
    const woods = createNoise2D(mulberry32(seed ^ 0x1234));
    const seams = createNoise2D(mulberry32(seed ^ 0xabcd));

    for (let iz = 0; iz < RESOURCE_CELLS; iz++) {
      for (let ix = 0; ix < RESOURCE_CELLS; ix++) {
        const x = this.worldX(ix);
        const z = this.worldZ(iz);
        const y = this.field.baseHeightAt(x, z);
        if (y < WATER_LEVEL) continue;

        // The flood plain: low ground near the water, but not in it.
        if (y < WATER_LEVEL + 18) {
          this.resources[iz * RESOURCE_CELLS + ix] = Resource.Fertile;
          continue;
        }
        // Woods on the gentler high ground, ore in a few tight blobs.
        const wood = woods(x / 900, z / 900);
        const ore = seams(x / 420, z / 420);
        if (ore > 0.72) this.resources[iz * RESOURCE_CELLS + ix] = Resource.Ore;
        else if (wood > 0.28) this.resources[iz * RESOURCE_CELLS + ix] = Resource.Forest;
      }
    }
    // A handful of extra seams, so ore is not only ever on the same contour.
    for (let n = 0; n < 6; n++) {
      const cx = rand() * MAP_SIZE - MAP_SIZE / 2;
      const cz = rand() * MAP_SIZE - MAP_SIZE / 2;
      const radius = 60 + rand() * 70;
      this.paint(cx, cz, radius, Resource.Ore);
    }
  }

  /** Paint a disc of one resource, used by the generator and by scenarios. */
  paint(x: number, z: number, radius: number, resource: Resource): void {
    const x0 = this.gridX(x - radius);
    const x1 = this.gridX(x + radius);
    const z0 = this.gridZ(z - radius);
    const z1 = this.gridZ(z + radius);
    for (let iz = z0; iz <= z1; iz++) {
      for (let ix = x0; ix <= x1; ix++) {
        if (ix < 0 || iz < 0 || ix >= RESOURCE_CELLS || iz >= RESOURCE_CELLS) continue;
        const px = this.worldX(ix);
        const pz = this.worldZ(iz);
        if (Math.hypot(px - x, pz - z) > radius) continue;
        if (this.field.baseHeightAt(px, pz) < WATER_LEVEL) continue;
        this.resources[iz * RESOURCE_CELLS + ix] = resource;
      }
    }
  }

  resourceAt(x: number, z: number): Resource {
    const ix = this.gridX(x);
    const iz = this.gridZ(z);
    if (ix < 0 || iz < 0 || ix >= RESOURCE_CELLS || iz >= RESOURCE_CELLS) return Resource.None;
    return this.resources[iz * RESOURCE_CELLS + ix] as Resource;
  }

  /** True where the ground is under water. */
  isWater(x: number, z: number): boolean {
    return this.field.baseHeightAt(x, z) < WATER_LEVEL;
  }

  /** True when water is within `radius` [m]: what a fishing wharf needs. */
  nearWater(x: number, z: number, radius = 40): boolean {
    for (let a = 0; a < 8; a++) {
      const angle = (a / 8) * Math.PI * 2;
      if (this.isWater(x + Math.cos(angle) * radius, z + Math.sin(angle) * radius)) return true;
    }
    return this.isWater(x, z);
  }

  /** The raw grid, for the save file. */
  snapshot(): Uint8Array {
    return this.resources.slice();
  }

  restore(values: Uint8Array): void {
    this.resources.set(values.subarray(0, this.resources.length));
  }

  private gridX(x: number): number {
    return Math.floor((x + MAP_SIZE / 2) / RESOURCE_CELL);
  }

  private gridZ(z: number): number {
    return Math.floor((z + MAP_SIZE / 2) / RESOURCE_CELL);
  }

  private worldX(ix: number): number {
    return ix * RESOURCE_CELL - MAP_SIZE / 2 + RESOURCE_CELL / 2;
  }

  private worldZ(iz: number): number {
    return iz * RESOURCE_CELL - MAP_SIZE / 2 + RESOURCE_CELL / 2;
  }
}
