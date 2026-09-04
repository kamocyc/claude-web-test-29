import {
  Color,
  DoubleSide,
  MeshStandardMaterial,
  Matrix4,
  Object3D,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from 'three';
import { InstancePool } from '../look/instancePool';
import { GROUND } from '../look/groundPalette';
import { BuildingType } from '../core/types';
import { BuildingParts, setBuildingNight, setBuildingSky } from '../look/buildingParts';
import { composeBuilding, rnd, type BuildCtx, type Facing } from '../look/buildingShapes';
import { meshStyle, TIN_ROOFS } from '../look/style';
import { atmosphereAt, sunDirection } from '../look/sky';
import type { ZoneType } from '../track/network/zoning';
import type { CityBuilding } from './buildings';
import { civicKind } from './civic';
import type { CityWorld } from './world';

/**
 * The buildings, as buildings.
 *
 * They were one box per plot with a colour on it. From the air that reads as
 * a model made of folded paper, and from the street it reads as nothing at
 * all -- and the buildings are the city, so this was the single biggest thing
 * between the view and looking like a place.
 *
 * The shape library is the source's and does the work: how a building is
 * stacked (a base, a setback, a penthouse, rooftop plant, an awning, a sign)
 * lives in `buildingShapes`, and how it is drawn lives in `buildingParts`,
 * which sorts every piece into a dozen instanced meshes. Windows, balconies
 * and shutters are drawn by the shader from the wall's own local
 * coordinates rather than modelled, so a street of a thousand buildings costs
 * the same handful of draw calls as one.
 *
 * The one thing that had to change is the direction they face. The source's
 * streets were a grid, so every building was axis-aligned and the whole
 * library is written that way. Here a plot faces whatever direction its road
 * runs, so each building is composed in its own frame and rotated as it is
 * placed -- see `BuildingParts.setFrame`.
 */

/**
 * The uses whose empty ground is paved rather than bare.
 *
 * A house that has not been built yet stands on a graded plot of earth; a
 * warehouse yard is concrete from the kerb to the back fence. Making the
 * distinction is what stops a whole zoned district reading as one sheet of
 * brown card while it fills in.
 */
const PAVED_ZONES = new Set<ZoneType>(['commercial', 'office', 'industrial', 'fishery', 'mining']);

/** What each painted use is built as. Several keys per use, chosen by hash. */
const ZONE_KEYS: Record<ZoneType, readonly string[]> = {
  residential: ['house', 'house', 'house', 'apartment'],
  apartment: ['apartment', 'mansion', 'mansion', 'tower'],
  commercial: ['konbini', 'shotengai', 'shotengai', 'supermarket'],
  office: ['office', 'zakkyo', 'zakkyo', 'office'],
  industrial: ['factory', 'smallfactory', 'warehouse', 'smallfactory'],
  farm: ['ricemill', 'field', 'paddy', 'ricemill'],
  forestry: ['sawmill', 'forestry', 'sawmill', 'forestry'],
  fishery: ['warehouse', 'smallfactory', 'warehouse', 'warehouse'],
  mining: ['smallfactory', 'warehouse', 'smallfactory', 'smallfactory'],
};

/** What each of the city's own buildings is built as. */
const CIVIC_KEYS: Partial<Record<BuildingType, string>> = {
  [BuildingType.School]: 'school',
  [BuildingType.Hospital]: 'hospital',
  [BuildingType.PoliceStation]: 'police',
  [BuildingType.FireStation]: 'fire',
  [BuildingType.Park]: 'park',
};

const UP = new Vector3(0, 1, 0);
const hsl = { h: 0, s: 0, l: 0 };
const sun = new Vector3();

/**
 * Scatter a base colour by the building's hash.
 *
 * Hue, saturation and lightness get their own draws. Taking all three from
 * one number correlates them, and a correlated scatter reads as a *gradient*
 * across the town -- light ones yellow, dark ones blue -- rather than as
 * variety.
 */
function scatterColor(base: number, hash: number, out: Color, strength = 1): Color {
  out.setHex(base);
  out.getHSL(hsl);
  const a = rnd(hash, 601) - 0.5;
  const b = rnd(hash, 602) - 0.5;
  const c = rnd(hash, 603) - 0.5;
  out.setHSL(
    (hsl.h + a * (16 / 360) * strength + 1) % 1,
    Math.max(0, Math.min(1, hsl.s * (1 + b * 0.4 * strength))),
    Math.max(0.03, Math.min(0.97, hsl.l * (1 + c * 0.24 * strength))),
  );
  return out;
}

export class BuildingView {
  readonly group = new Object3D();
  private readonly parts = new BuildingParts();
  private readonly wall = new Color();
  private readonly roof = new Color();
  private readonly ctx: BuildCtx;
  private signature = -1;

  /**
   * The ground of plots that are zoned but not yet built on.
   *
   * Without it, painting a district changes nothing you can see until a
   * building appears on it, and the town's edge is lawn right up to the kerb.
   * A plot waiting for a building is graded earth or a concrete yard, and
   * showing the *material* rather than the zone's colour keeps it looking
   * like ground instead of like a data overlay.
   */
  private readonly pads: InstancePool;
  private readonly padMaterial: MeshStandardMaterial;

  constructor() {
    this.group.name = 'city-buildings';
    this.group.add(this.parts.group);

    const pad = new PlaneGeometry(1, 1);
    pad.rotateX(-Math.PI / 2);
    this.padMaterial = new MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.96,
      metalness: 0,
      side: DoubleSide,
      // Just above the terrain, and biased, or the two surfaces argue about
      // which is in front and the plot flickers as the camera moves.
      polygonOffset: true,
      polygonOffsetFactor: 0,
      polygonOffsetUnits: -3,
    });
    this.pads = new InstancePool(pad, this.padMaterial, this.group, true, 512);
    this.pads.setShadows(false, true);
    this.ctx = {
      e: this.parts,
      cx: 0,
      cz: 0,
      gy: 0,
      w: 1,
      d: 1,
      height: 1,
      level: 1,
      hash: 0,
      front: 2,
      style: meshStyle('house'),
      wall: this.wall,
      roof: this.roof,
      roofRough: 0.74,
      roofMetal: 0.06,
    };
  }

  /**
   * Light the windows.
   *
   * Not by switching whole bands on: the shader picks which rooms are lit
   * from (floor, bay, building hash), so all this has to pass is how far
   * through the evening it is, and the lights come on a few at a time.
   */
  setTimeOfDay(dayFraction: number): void {
    const atmo = atmosphereAt(dayFraction);
    setBuildingNight(atmo.nightAmount);
    sunDirection(dayFraction, sun);
    setBuildingSky(atmo.zenith, atmo.horizon, sun, atmo.sunColor, atmo.sunIntensity);
  }

  /**
   * Rebuild, but only when what is standing has changed.
   *
   * The check runs every frame, so it is a number rolled up in one pass
   * rather than a list of strings: building a key out of every building's id
   * and plot allocated a megabyte a second in a large city, to answer a
   * question that is nearly always "nothing has changed".
   */
  update(world: CityWorld, buildings: readonly CityBuilding[]): void {
    let signature = Math.imul(world.revision + 1, 2654435761) >>> 0;
    for (const building of buildings) {
      if (!building.alive) continue;
      signature = (Math.imul(signature ^ building.id, 16777619) ^ building.lot) >>> 0;
    }
    if (signature === this.signature) return;
    this.signature = signature;

    this.parts.reset();
    const taken = new Set<number>();
    for (const building of buildings) {
      if (!building.alive) continue;
      if (building.lot >= 0) taken.add(building.lot);
      this.compose(world, building);
    }
    this.parts.clearFrame();
    this.parts.flush();
    this.layPads(world, taken);
  }

  /** Bare ground on every plot nobody has built on yet. */
  private layPads(world: CityWorld, taken: ReadonlySet<number>): void {
    const matrix = new Matrix4();
    const quaternion = new Quaternion();
    const scale = new Vector3();
    const at = new Vector3();
    const tint = new Color();

    this.pads.begin();
    world.lots.forEach((lot, index) => {
      if (taken.has(index)) return;
      const hash = positionHash(lot.center.x, lot.center.z);
      const paved = PAVED_ZONES.has(lot.zone);
      tint.setHex(paved ? GROUND.lotPaved : GROUND.lotBare);
      // A shade per plot, or a row of empty ones is a single flat rectangle.
      const shade = 0.9 + ((hash >>> 7) % 20) / 100;
      tint.multiplyScalar(shade);

      // Square to the road, like the building that will stand here.
      quaternion.setFromAxisAngle(UP, Math.atan2(-lot.along.z, lot.along.x));
      at.set(lot.center.x, lot.padY + 0.02, lot.center.z);
      scale.set(lot.halfFrontage * 2 * 0.94, 1, lot.depth * 0.94);
      matrix.compose(at, quaternion, scale);
      this.pads.push(matrix, tint);
    });
    this.pads.end();
  }

  private compose(world: CityWorld, building: CityBuilding): void {
    const civic = civicKind(building.type);
    const key = civic
      ? CIVIC_KEYS[building.type]
      : pick(ZONE_KEYS[building.zone], building.at);
    if (!key) return;

    const lot = building.lot >= 0 ? world.lots[building.lot] : undefined;
    // A hash of the ground, not of the building's index: a plot rebuilt after
    // a street moved should put the same building back, and the index is
    // reused when somebody moves out.
    const hash = positionHash(building.at.x, building.at.z);
    const ctx = this.ctx;
    const style = meshStyle(key);
    ctx.style = style;
    ctx.hash = hash;

    if (lot) {
      // Along the road is the building's own X; away from the road is its Z.
      const along = lot.along;
      const yaw = Math.atan2(-along.z, along.x);
      // Which way is the street? The frontage has to face it, or every
      // building in town turns its back on the road it is entered from.
      const localZ = -along.z * lot.outward.x + along.x * lot.outward.z;
      ctx.front = (localZ > 0 ? 2 : 0) as Facing;
      ctx.w = lot.halfFrontage * 2 * style.inset;
      ctx.d = lot.depth * style.inset;
      ctx.cx = lot.center.x;
      ctx.cz = lot.center.z;
      ctx.gy = lot.padY;
      this.parts.setFrame(lot.center.x, lot.center.z, yaw);
    } else {
      // The city's own buildings do not stand on plots. They are square to
      // the world and sized by the kind, which is what reserved their ground.
      const half = civic ? civic.half : 10;
      ctx.front = 2;
      ctx.w = half * 2 * style.inset;
      ctx.d = half * 1.5 * style.inset;
      ctx.cx = building.at.x;
      ctx.cz = building.at.z;
      ctx.gy = world.field.heightAt(building.at.x, building.at.z);
      this.parts.clearFrame();
    }

    ctx.level = levelOf(building, key);
    // Jittered, then snapped to whole floors by the shapes: the scatter comes
    // out as "one storey more or less", which is what gives a street its
    // skyline instead of a flat top.
    ctx.height = (style.baseHeight + style.perLevel * (ctx.level - 1))
      * (0.93 + rnd(hash, 60) * 0.16);

    const wallBase = style.walls[Math.floor(rnd(hash, 70) * style.walls.length) % style.walls.length];
    scatterColor(wallBase, hash, this.wall);
    const roofBase = style.roofs[Math.floor(rnd(hash, 71) * style.roofs.length) % style.roofs.length];
    // Roofs are scattered less than walls. From above, roofs are most of the
    // frame, and a roof hue that wanders reads as a broken palette rather
    // than as variety.
    scatterColor(roofBase, hash ^ 0x5bf03, this.roof, 0.7);
    const tin = TIN_ROOFS.has(roofBase);
    ctx.roofRough = tin ? 0.42 : 0.79;
    ctx.roofMetal = tin ? 0.55 : 0.06;

    composeBuilding(key, ctx);
  }
}

/** How many storeys. Capacity is the only thing the city knows about size. */
function levelOf(building: CityBuilding, key: string): number {
  if (key === 'house' || key === 'park' || key === 'paddy' || key === 'field') return 1;
  const capacity = Math.max(1, building.capacity);
  if (key === 'tower' || key === 'mansion') return Math.min(9, 2 + Math.round(capacity / 6));
  if (key === 'apartment') return Math.min(5, 2 + Math.round(capacity / 8));
  return Math.min(6, 1 + Math.round(capacity / 10));
}

function pick(keys: readonly string[], at: Vector3): string {
  return keys[positionHash(at.x, at.z) % keys.length];
}

/** A stable hash of a place. Same ground, same building. */
function positionHash(x: number, z: number): number {
  let h = Math.imul(Math.round(x * 4) ^ 0x9e3779b9, 2654435761);
  h ^= Math.imul(Math.round(z * 4) + 0x85ebca6b, 40503);
  h ^= h >>> 13;
  return h >>> 0;
}
