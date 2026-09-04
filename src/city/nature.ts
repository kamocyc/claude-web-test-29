import {
  Color,
  Group,
  Matrix4,
  Quaternion,
  Vector3,
  type BufferGeometry,
} from 'three';
import { createPropMaterial } from '../track/render/materials';
import { hash2, valueNoise } from '../look/groundPalette';
import { InstancePool } from '../look/instancePool';
import { Season, seasonOnDay } from '../look/season';
import {
  bambooGeometry,
  broadleafGeometry,
  coniferGeometry,
  rockGeometry,
  shrubGeometry,
} from '../look/vegetation';
import { Resource } from './terrain';
import type { CityWorld } from './world';

/**
 * What grows on the ground the city has not taken.
 *
 * Empty land was the thing most obviously missing. The terrain had a colour
 * and nothing else, so every field between the streets read as a painted
 * surface rather than as somewhere -- and the ground is most of the frame in
 * a game seen from above.
 *
 * Two rules decide where a plant goes, and they are the same two a surveyor
 * would use. It must not be where the city is (a road, a plot, a building),
 * and it must be on ground that would actually grow it: conifers and bamboo
 * on the wooded resource, broadleaf and scrub elsewhere, nothing on rock,
 * nothing in the water. Everything is placed from a hash of its own position,
 * so the same ground grows the same wood every time the world is rebuilt, and
 * re-laying a street across town does not reshuffle the forest.
 */

/** How far apart the planting grid samples [m]. */
const CELL = 14;
/** How far from a road or a plot a plant must stand [m]. */
const CLEARANCE = 13;
/** How far out from the camera's target anything is planted [m]. */
const REACH = 1400;
/** Slope above which the ground is bare rock rather than woodland [deg]. */
const BARE_SLOPE = 34;

interface Kinds {
  conifer: BufferGeometry;
  broadleaf: BufferGeometry;
  bamboo: BufferGeometry;
  shrub: BufferGeometry;
}

function kindsFor(season: Season): Kinds {
  return {
    conifer: coniferGeometry(season, 0.5),
    // Branched, and bare only in winter -- the one tree in the set that
    // shows the season in its silhouette rather than only in its colour.
    broadleaf: broadleafGeometry(season, 0.5, true, season === Season.Winter),
    bamboo: bambooGeometry(season, 0.5),
    shrub: shrubGeometry(season, 0.5),
  };
}

export class NatureLayer {
  readonly group = new Group();

  private readonly conifer: InstancePool;
  private readonly broadleaf: InstancePool;
  private readonly bamboo: InstancePool;
  private readonly shrub: InstancePool;
  private readonly rock: InstancePool;
  private readonly geometries = new Map<Season, Kinds>();

  /** What was planted last, so an unchanged world is not replanted. */
  private signature = '';
  private season: Season = Season.Summer;
  /**
   * Where the city is, stamped into a grid.
   *
   * Kept across pans and rebuilt only when the network changes. Re-stamping
   * every segment because the camera moved was half the cost of replanting,
   * and the answer it produces does not depend on where the camera is.
   */
  private taken: { revision: number; near(x: number, z: number): boolean } | null = null;

  constructor() {
    const material = createPropMaterial();
    const first = this.kinds(Season.Summer);
    this.conifer = new InstancePool(first.conifer, material, this.group, true, 2048);
    this.broadleaf = new InstancePool(first.broadleaf, material, this.group, true, 2048);
    this.bamboo = new InstancePool(first.bamboo, material, this.group, true, 512);
    this.shrub = new InstancePool(first.shrub, material, this.group, true, 1024);
    this.rock = new InstancePool(rockGeometry(1, false), material, this.group, true, 256);
    // Through the pool, not on the mesh: the mesh is replaced when the pool
    // grows, and trees overflow their first capacity before the opening frame.
    for (const pool of this.pools) pool.setShadows(true, false);
  }

  private get pools(): InstancePool[] {
    return [this.conifer, this.broadleaf, this.bamboo, this.shrub, this.rock];
  }

  private kinds(season: Season): Kinds {
    let kinds = this.geometries.get(season);
    if (!kinds) {
      kinds = kindsFor(season);
      this.geometries.set(season, kinds);
    }
    return kinds;
  }

  /**
   * Replant, but only when something that decides the planting has changed.
   *
   * The world's revision covers the network and the plots; the season covers
   * the colour; the centre covers which part of the map is near enough to be
   * worth planting at all. Nothing else can move a tree.
   */
  update(world: CityWorld, day: number, centre: Vector3): void {
    const season = seasonOnDay(day);
    // Big steps. Replanting is the most expensive thing this layer does, so
    // it should happen when the view has really moved, not while panning.
    const cx = Math.round(centre.x / 700) * 700;
    const cz = Math.round(centre.z / 700) * 700;
    const signature = `${world.revision}:${season}:${cx},${cz}`;
    if (signature === this.signature) return;
    this.signature = signature;

    if (season !== this.season) {
      this.season = season;
      const kinds = this.kinds(season);
      this.conifer.setGeometry(kinds.conifer);
      this.broadleaf.setGeometry(kinds.broadleaf);
      this.bamboo.setGeometry(kinds.bamboo);
      this.shrub.setGeometry(kinds.shrub);
    }

    this.plant(world, cx, cz);
  }

  private plant(world: CityWorld, cx: number, cz: number): void {
    for (const pool of this.pools) pool.begin();

    if (!this.taken || this.taken.revision !== world.revision) {
      this.taken = { revision: world.revision, ...occupancy(world) };
    }
    const taken = this.taken;
    const matrix = new Matrix4();
    const quaternion = new Quaternion();
    const scale = new Vector3();
    const at = new Vector3();
    const tint = new Color();

    for (let z = cz - REACH; z <= cz + REACH; z += CELL) {
      for (let x = cx - REACH; x <= cx + REACH; x += CELL) {
        const r = hash2(x * 0.37, z * 0.37);
        // Jittered off the grid, or a wood looks like an orchard.
        const px = x + (r - 0.5) * CELL * 1.6;
        const pz = z + (hash2(z * 0.21, x * 0.21) - 0.5) * CELL * 1.6;
        if (!world.field.contains(px, pz)) continue;

        const y = world.field.baseHeightAt(px, pz);
        if (world.terrain.isWater(px, pz)) continue;
        if (taken.near(px, pz)) continue;

        const slope = slopeAt(world, px, pz);
        if (slope > BARE_SLOPE) {
          // Rock, not woodland -- and sparse, or a hillside turns to rubble.
          if (r < 0.86) continue;
          const rockSpin = hash2(px * 0.53, pz * 0.53);
          place(this.rock, matrix, quaternion, scale, at.set(px, y, pz), 1.4 + rockSpin * 2.4, rockSpin);
          continue;
        }

        const resource = world.terrain.resourceAt(px, pz);
        const wooded = resource === Resource.Forest;
        // Density from the noise, not from a flat probability: a wood has
        // edges and clearings, and a uniform scatter has neither.
        const density = valueNoise(px * 0.006, pz * 0.006);
        const wants = wooded ? 0.28 + density * 0.62 : density * 0.34;
        if (r > wants) continue;

        // Independent draws for what grows and which way it faces. Reusing
        // `r` -- which has just been through a "less than the density" test --
        // correlates the species with the density: off the wooded ground it
        // can never exceed 0.34, so a shrub (which needs 0.45) was never
        // planted at all, and a bamboo needed a one-in-a-thousand cell.
        const kindRoll = hash2(px * 0.71 + 13.3, pz * 0.71 - 7.1);
        const spin = hash2(pz * 1.31 + 5.7, px * 1.31 + 2.9);

        const height = 4 + hash2(px, pz) * (wooded ? 8 : 5);
        const shade = 0.82 + hash2(pz, px) * 0.34;
        tint.setRGB(shade, shade * 0.99, shade * 0.96);

        const pool = wooded
          ? (kindRoll < 0.62 ? this.conifer : kindRoll < 0.86 ? this.broadleaf : this.bamboo)
          : (kindRoll < 0.45 ? this.broadleaf : this.shrub);
        const size = pool === this.shrub ? height * 0.35 : height;
        place(pool, matrix, quaternion, scale, at.set(px, y, pz), size, spin, tint);
      }
    }

    for (const pool of this.pools) pool.end();
  }
}

function place(
  pool: InstancePool,
  matrix: Matrix4,
  quaternion: Quaternion,
  scale: Vector3,
  at: Vector3,
  height: number,
  spin: number,
  tint?: Color,
): void {
  quaternion.setFromAxisAngle(UP, spin * Math.PI * 2);
  // A little wider than tall on some, narrower on others: identical
  // proportions read as one tree copied, which is what it is.
  const width = height * (0.7 + spin * 0.5);
  scale.set(width, height, width);
  matrix.compose(at, quaternion, scale);
  pool.push(matrix, tint);
}

const UP = new Vector3(0, 1, 0);

function slopeAt(world: CityWorld, x: number, z: number): number {
  const h = world.field.baseHeightAt(x, z);
  const dx = world.field.baseHeightAt(x + 6, z) - h;
  const dz = world.field.baseHeightAt(x, z + 6) - h;
  return (Math.atan(Math.hypot(dx, dz) / 6) * 180) / Math.PI;
}

/**
 * Where the city already is, as a coarse grid.
 *
 * Asking "is this within thirteen metres of any road" by walking every
 * alignment would be a search per plant, and there are tens of thousands of
 * plants. Stamping the network into a grid once costs one pass and answers
 * every question after it in constant time.
 */
function occupancy(world: CityWorld): { near(x: number, z: number): boolean } {
  const cells = new Set<number>();
  const key = (x: number, z: number): number =>
    Math.floor(x / CELL) * 100_000 + Math.floor(z / CELL);
  const stamp = (x: number, z: number, radius: number): void => {
    const steps = Math.ceil(radius / CELL);
    for (let dz = -steps; dz <= steps; dz++) {
      for (let dx = -steps; dx <= steps; dx++) {
        cells.add(key(x + dx * CELL, z + dz * CELL));
      }
    }
  };

  for (const segment of world.net.segments.values()) {
    const alignment = world.net.alignmentOf(segment.id);
    const width = world.net.classOf(segment).halfWidth + CLEARANCE;
    const step = Math.max(6, CELL * 0.6);
    for (let s = 0; s <= alignment.length; s += step) {
      const p = alignment.sampleAt(s).pos;
      stamp(p.x, p.z, width);
    }
  }
  for (const lot of world.lots) stamp(lot.center.x, lot.center.z, lot.depth);
  for (const station of world.net.stations.values()) {
    stamp(station.center.x, station.center.z, station.length * 0.6);
  }

  return {
    near(x: number, z: number): boolean {
      return cells.has(key(x, z));
    },
  };
}
