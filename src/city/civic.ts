import { Vector3 } from 'three';
import { BuildingType } from '../core/types';
import { isLeisure, leisureDraw, specFor } from '../world/buildings';
import type { CityBuilding } from './buildings';
import { roadLanesNear } from './transit';
import type { CityWorld } from './world';

/**
 * The things the city builds for itself.
 *
 * Everything else in this city is grown: the player paints a use and demand
 * decides what appears. These are the opposite -- placed by hand, paid for by
 * the city, and never abandoned -- and that difference is the point of them.
 * Zoning is a bet on what people will do; a hospital is a decision.
 *
 * They stand on open ground beside a road rather than on the engine's plots.
 * A plot is a shop-sized rectangle facing the street, which is right for a
 * shop and wrong for a park, a stadium, or anything with a car park. The one
 * thing they do share with a plot is the rule that matters: a building nobody
 * can reach is not a building, so a site with no road near it is refused.
 */

export interface CivicKind {
  type: BuildingType;
  label: string;
  /** What it costs to put up. Upkeep comes from the building spec. */
  cost: number;
  /**
   * How far its good reaches [m].
   *
   * For a service this is its catchment; for a venue it is how far somebody
   * will travel to it, which is the same number seen from the other end.
   */
  reach: number;
  /** Half the footprint it needs clear of other buildings [m]. */
  half: number;
}

export const CIVIC_KINDS: readonly CivicKind[] = [
  { type: BuildingType.Park, label: '公園', cost: 12_000, reach: 260, half: 16 },
  { type: BuildingType.School, label: '学校', cost: 68_000, reach: 520, half: 22 },
  { type: BuildingType.Hospital, label: '病院', cost: 120_000, reach: 700, half: 24 },
  { type: BuildingType.PoliceStation, label: '警察署', cost: 58_000, reach: 560, half: 18 },
  { type: BuildingType.FireStation, label: '消防署', cost: 62_000, reach: 560, half: 18 },
  { type: BuildingType.Stadium, label: '競技場', cost: 210_000, reach: 900, half: 34 },
  { type: BuildingType.AmusementPark, label: '遊園地', cost: 320_000, reach: 1400, half: 40 },
];

export function civicKind(type: BuildingType): CivicKind | null {
  return CIVIC_KINDS.find((k) => k.type === type) ?? null;
}

/** How near a road a civic building has to stand [m]. */
export const ROAD_REACH = 90;

export type SiteRefusal = 'road' | 'space' | 'water' | 'money';

export const REFUSAL_TEXT: Record<SiteRefusal, string> = {
  road: '道路から遠すぎます',
  space: '別の建物と重なります',
  water: '水の上には建てられません',
  money: '資金が足りません',
};

/**
 * Whether a civic building of this kind can stand here.
 *
 * Returns null when it can. The refusals are deliberately the same three a
 * player would work out by looking: too far from a road, on top of something,
 * or in the water.
 */
export function siteRefusal(
  world: CityWorld,
  buildings: readonly CityBuilding[],
  kind: CivicKind,
  at: Vector3,
): SiteRefusal | null {
  if (world.terrain.isWater(at.x, at.z)) return 'water';
  if (roadLanesNear(world, at, ROAD_REACH).length === 0) return 'road';

  // Clear of what is actually standing -- and only that. An empty plot is not
  // a building, it is somewhere a building *could* go, and the roadside is
  // covered in them: refusing every plot means refusing every site in town,
  // which is what the first version of this did. Instead the plots a civic
  // building covers are taken off the market (see `coveredLots`), so the city
  // does not later grow a house through the middle of a park.
  for (const building of buildings) {
    if (!building.alive) continue;
    const other = civicKind(building.type);
    const gap = kind.half + (other ? other.half : 8);
    if (building.at.distanceTo(at) < gap) return 'space';
  }
  return null;
}

/**
 * The plots a set of civic buildings is standing on.
 *
 * Growth skips these. Without it a park and a house end up on the same ground
 * -- the park was placed there deliberately, so the park wins.
 */
export function coveredLots(
  world: CityWorld,
  buildings: readonly CityBuilding[],
): Set<number> {
  const covered = new Set<number>();
  for (const building of buildings) {
    if (!building.alive) continue;
    const kind = civicKind(building.type);
    if (!kind) continue;
    world.lots.forEach((lot, i) => {
      if (lot.center.distanceTo(building.at) < kind.half + lot.depth / 2) covered.add(i);
    });
  }
  return covered;
}

/**
 * The nearest civic building of a kind, and how far away it is.
 *
 * Distance as the crow flies rather than along the roads, and on purpose: a
 * fire station's usefulness is about how far the engine has to drive, which
 * the road distance would answer better, but a citizen judging whether their
 * neighbourhood *has* a hospital is judging by the map. The road network gets
 * its say already -- a building with no road to it cannot be placed.
 */
export function nearest(
  buildings: readonly CityBuilding[],
  type: BuildingType,
  at: Vector3,
): { building: CityBuilding; distance: number } | null {
  let best: { building: CityBuilding; distance: number } | null = null;
  for (const building of buildings) {
    if (!building.alive || building.type !== type) continue;
    const distance = building.at.distanceTo(at);
    if (!best || distance < best.distance) best = { building, distance };
  }
  return best;
}

/**
 * How well a place is served, from 0 to 1.
 *
 * Full marks inside half the reach, nothing beyond it, and a straight fall in
 * between: being on the edge of a catchment is worth something, but less than
 * being in the middle of one.
 */
export function coverage(
  buildings: readonly CityBuilding[],
  type: BuildingType,
  at: Vector3,
): number {
  const kind = civicKind(type);
  if (!kind) return 0;
  const found = nearest(buildings, type, at);
  if (!found) return 0;
  const inner = kind.reach / 2;
  if (found.distance <= inner) return 1;
  if (found.distance >= kind.reach) return 0;
  return 1 - (found.distance - inner) / (kind.reach - inner);
}

/** What the civic buildings are doing for somebody standing here. */
export interface ServiceReport {
  health: number;
  safety: number;
  education: number;
  /** Recreation: the best venue in reach, weighted by how much of a draw it is. */
  leisure: number;
}

export function servicesAt(buildings: readonly CityBuilding[], at: Vector3): ServiceReport {
  let leisure = 0;
  for (const kind of CIVIC_KINDS) {
    if (!isLeisure(kind.type)) continue;
    // The best venue in reach, not the sum of them: a second park round the
    // corner is worth much less than the first, and a fairground across town
    // is worth more than either.
    const reached = coverage(buildings, kind.type, at) * Math.min(1, leisureDraw(kind.type) / 2);
    leisure = Math.max(leisure, reached);
  }
  return {
    health: coverage(buildings, BuildingType.Hospital, at),
    safety: Math.max(
      coverage(buildings, BuildingType.PoliceStation, at),
      coverage(buildings, BuildingType.FireStation, at) * 0.8,
    ),
    education: coverage(buildings, BuildingType.School, at),
    leisure,
  };
}

/** What the whole set is costing the city a day. */
export function civicUpkeep(buildings: readonly CityBuilding[]): number {
  let total = 0;
  for (const b of buildings) {
    if (b.alive && civicKind(b.type)) total += specFor(b.type).upkeep;
  }
  return total;
}
