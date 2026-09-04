import { Color, Object3D, Vector3 } from 'three';
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
  private signature = '';

  constructor() {
    this.group.name = 'city-buildings';
    this.group.add(this.parts.group);
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

  /** Rebuild, but only when what is standing has changed. */
  update(world: CityWorld, buildings: readonly CityBuilding[]): void {
    const standing = buildings.filter((b) => b.alive);
    const signature = `${world.revision}:${standing.map((b) => `${b.id}.${b.lot}`).join(',')}`;
    if (signature === this.signature) return;
    this.signature = signature;

    this.parts.reset();
    for (const building of standing) this.compose(world, building);
    this.parts.clearFrame();
    this.parts.flush();
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
