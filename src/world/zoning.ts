import {
  ABANDON_AFTER_HOURS,
  BUILDINGS_PER_GROWTH_STEP,
  CHAIN_HEADROOM,
  GOODS_PER_RESIDENT_PER_DAY,
  HIGH_DENSITY_LAND_VALUE,
  RESIDENTS_PER_SHOP,
  JOB_SURPLUS_RATIO,
} from '../config';
import { manhattan } from '../core/grid';
import { BuildingType, Industry, Zone, type TileIndex } from '../core/types';
import {
  buildingForZone,
  hasVacancy,
  industryOf,
  isWorkplace,
  operatingRatio,
  specFor,
  type Building,
} from './buildings';
import type { World } from './world';

/**
 * What the city is short of, recomputed each growth step.
 *
 * Growth is demand-driven, and with a supply chain in the world "demand" is no
 * longer one number. A city can have plenty of vacant jobs and still be
 * failing because its shops have nothing to sell; the fix for that is a
 * factory, not another shop. So the growth step asks what is actually missing
 * and builds that, which is what makes the chain visible as a sequence of
 * decisions rather than as a hidden multiplier.
 */
export interface Demand {
  jobless: number;
  vacantJobs: number;
  vacantHomes: number;
  /** Shops that have run dry, and factories with no raw materials. */
  shopsStarved: number;
  factoriesStarved: number;
  /** Shops and factories currently able to work at all. */
  shops: number;
  factories: number;
  primaries: number;

  /**
   * The chain measured as rates rather than as counts.
   *
   * Counting starving buildings was enough while goods teleported: a surplus
   * factory simply piled up stock that nobody had to carry. Now every unit
   * rides on a lorry, and a city with four times the factories it needs does
   * not merely waste the land -- its phantom demand consumes the whole fleet
   * and the shops it was supposed to supply run dry. So growth asks whether
   * the city can *make* what it consumes, not whether somebody is short.
   */
  goodsPerHour: number;
  goodsCapacity: number;
  rawPerHour: number;
  rawCapacity: number;
  /** Shops the population can actually keep busy. */
  shopsNeeded: number;
}

export function measureDemand(world: World): Demand {
  const d: Demand = {
    jobless: 0,
    vacantJobs: 0,
    vacantHomes: 0,
    shopsStarved: 0,
    factoriesStarved: 0,
    shops: 0,
    factories: 0,
    primaries: 0,
    goodsPerHour: (world.population * GOODS_PER_RESIDENT_PER_DAY) / 24,
    goodsCapacity: 0,
    rawPerHour: 0,
    rawCapacity: 0,
    shopsNeeded: Math.max(1, Math.ceil(world.population / RESIDENTS_PER_SHOP)),
  };

  for (const c of world.citizens) {
    if (c.work < 0 || !world.isAlive(world.buildings[c.work])) d.jobless++;
  }

  for (const b of world.buildings) {
    if (!b.alive) continue;
    if (isWorkplace(b.type)) d.vacantJobs += b.capacity - b.occupants.length;
    switch (industryOf(b.type)) {
      case Industry.Retail:
        d.shops++;
        if (b.goodsStock <= 0) d.shopsStarved++;
        break;
      case Industry.Secondary:
        d.factories++;
        d.goodsCapacity += specFor(b.type).outputPerHour * operatingRatio(b);
        d.rawPerHour += specFor(b.type).rawPerHour * operatingRatio(b);
        // "Starved" has to mean *could not produce*, not "stock is empty".
        // A factory that is working converts everything it receives each hour,
        // so its raw pile is empty almost by definition -- reading that as
        // starvation makes the city build primary industry forever and never
        // anything else, which is exactly what it did before this comment.
        if (b.starvedHours > 0) d.factoriesStarved++;
        break;
      case Industry.Primary:
        d.primaries++;
        d.rawCapacity += specFor(b.type).outputPerHour * operatingRatio(b);
        break;
      default:
        break;
    }
  }
  d.vacantHomes = world.housingCapacity - world.population;
  return d;
}

/**
 * One growth step: build what the city is short of, and clear away what has
 * been failing long enough to be abandoned.
 *
 * `landValue` is passed in rather than read from a global so that the growth
 * rules stay a pure function of the world plus the fields the simulation has
 * already computed this hour -- which is what lets the tests drive growth
 * directly with a land value they choose.
 */
export function growCity(world: World, landValue: (tile: TileIndex) => number): void {
  abandonFailedBuildings(world);

  const demand = measureDemand(world);
  const targetSurplus = Math.max(4, Math.ceil(world.population * JOB_SURPLUS_RATIO));

  if (demand.vacantJobs < demand.jobless + targetSurplus) {
    const zone = nextWorkplaceZone(world, demand);
    if (zone !== null) grow(world, zone, BUILDINGS_PER_GROWTH_STEP, landValue);
  }

  // Housing follows jobs: people only move to a town that has work for them,
  // and the migration step will only fill these homes if they are worth
  // living in.
  if (demand.vacantJobs > 0 && demand.vacantHomes < Math.max(8, world.population * 0.1)) {
    grow(world, Zone.ResidentialHigh, 1, landValue);
    grow(world, Zone.ResidentialLow, BUILDINGS_PER_GROWTH_STEP, landValue);
  }

  assignJobs(world);
}

/**
 * Which workplace the city needs next, following the chain backwards from
 * wherever it is broken.
 *
 * Shops with nothing to sell mean factories; factories with nothing to work on
 * mean primary industry. Only when the chain is fed does the choice come down
 * to the ordinary question of shops versus offices.
 */
function nextWorkplaceZone(world: World, demand: Demand): Zone | null {
  const available = (zone: Zone): boolean => collectZonedTiles(world, zone).length > 0;

  // Enough of the chain to cover consumption, plus a margin so it is not
  // living exactly hand to mouth.
  const needsPrimary = demand.rawCapacity < demand.rawPerHour * CHAIN_HEADROOM;
  const needsFactory = demand.goodsCapacity < demand.goodsPerHour * CHAIN_HEADROOM;

  if (needsPrimary && (demand.factories > 0 || demand.primaries === 0)) {
    const primary = bestPrimaryZone(world);
    if (primary !== null) return primary;
  }
  if (needsFactory && available(Zone.Industrial)) return Zone.Industrial;

  // Enough shops for the people to shop in, and after that offices.
  //
  // Shops used to be the default job filler, which quietly scaled them with
  // the population rather than with trade: a city of a thousand grew a hundred
  // and forty of them, and every one wanted its shelves kept full by the same
  // finite fleet. Offices need no deliveries at all, which is exactly what
  // makes them the right place to put the jobs a city has left over.
  const wantShops = demand.shops < demand.shopsNeeded;
  const order = wantShops
    ? [Zone.Commercial, Zone.Office]
    : [Zone.Office, Zone.Commercial];
  for (const zone of order) {
    if (available(zone)) return zone;
  }
  return needsPrimary ? bestPrimaryZone(world) : null;
}

/** The primary zone with the most room, so growth follows what was zoned. */
function bestPrimaryZone(world: World): Zone | null {
  let best: Zone | null = null;
  let bestCount = 0;
  for (const zone of [Zone.Farm, Zone.Forestry, Zone.Fishery, Zone.Mining]) {
    const count = collectZonedTiles(world, zone).length;
    if (count > bestCount) {
      bestCount = count;
      best = zone;
    }
  }
  return best;
}

function grow(
  world: World,
  zone: Zone,
  limit: number,
  landValue: (tile: TileIndex) => number,
): number {
  const type = buildingForZone(zone);
  if (type === null) return 0;

  const candidates = collectZonedTiles(world, zone);
  if (candidates.length === 0) return 0;

  let built = 0;
  while (built < limit && candidates.length > 0) {
    const pick = world.rng.int(candidates.length);
    const tile = candidates[pick];
    candidates[pick] = candidates[candidates.length - 1];
    candidates.pop();

    // Nobody builds a tower on cheap land. Without this the high-density zone
    // would be strictly better than the low-density one everywhere, and the
    // choice between them would not be a choice.
    if (type === BuildingType.Apartment && landValue(tile) < HIGH_DENSITY_LAND_VALUE) continue;

    if (world.addBuilding(tile, type)) built++;
  }
  return built;
}

function collectZonedTiles(world: World, zone: Zone): TileIndex[] {
  const out: TileIndex[] = [];
  const { map } = world;
  for (let i = 0; i < map.zone.length; i++) {
    if (map.zone[i] === zone && map.isBuildable(i) && world.adjacentRoad(i) >= 0) {
      out.push(i);
    }
  }
  return out;
}

/**
 * A business that has had nothing to work with for days closes down.
 *
 * This is the other half of the supply chain being real: if a broken chain
 * only meant "no tax revenue" the player could ignore it, but a factory whose
 * raw materials never arrive eventually vacates the tile and takes its jobs
 * with it, and the unemployment shows up in the happiness figures.
 */
function abandonFailedBuildings(world: World): void {
  for (const b of world.buildings) {
    if (!b.alive || !isWorkplace(b.type)) continue;
    if (b.type === BuildingType.PowerPlant || b.type === BuildingType.Station) continue;
    if (b.starvedHours < ABANDON_AFTER_HOURS) continue;
    world.demolish(b.id);
  }
}

/**
 * Give every jobless citizen a workplace, by a lottery weighted towards the
 * near ones rather than always the nearest.
 *
 * Strict nearest-first looks reasonable and quietly ruins the city: everyone
 * ends up working a few blocks from home, every commute is short, and nothing
 * that rewards long trips -- arterial congestion, a rail line -- ever has any
 * demand to work with. A weighted draw keeps most people local while still
 * producing the cross-town commuters a real city has.
 */
const JOB_DISTANCE_BIAS = 10;

export function assignJobs(world: World): void {
  const openings = world.buildings.filter(
    (b) => world.isAlive(b) && isWorkplace(b.type) && hasVacancy(b),
  );
  if (openings.length === 0) return;

  for (const c of world.citizens) {
    if (c.work >= 0 && world.isAlive(world.buildings[c.work])) continue;

    const home = world.buildings[c.home];
    if (!home || !world.isAlive(home)) continue;

    const chosen = drawWorkplace(world, home, openings);
    if (!chosen) return;

    chosen.occupants.push(c.id);
    c.work = chosen.id;
    c.path = null;
  }
}

function drawWorkplace(world: World, home: Building, openings: Building[]): Building | null {
  let total = 0;
  for (const b of openings) {
    if (hasVacancy(b)) total += weightFor(home, b);
  }
  if (total <= 0) return null;

  let roll = world.rng.next() * total;
  for (const b of openings) {
    if (!hasVacancy(b)) continue;
    roll -= weightFor(home, b);
    if (roll <= 0) return b;
  }
  // Floating point can leave a sliver; fall back to any remaining vacancy.
  return openings.find(hasVacancy) ?? null;
}

function weightFor(home: Building, work: Building): number {
  // Better-paid work is worth a longer trip, which is what gives an office
  // district its catchment and keeps a farm's workforce local.
  const wage = specFor(work.type).wagePerJob;
  return (wage / 30) / (manhattan(home.tile, work.tile) + JOB_DISTANCE_BIAS);
}
