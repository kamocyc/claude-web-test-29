import { BuildingType, Industry, Zone, type BuildingId, type CitizenId, type TileIndex } from '../core/types';

export interface Building {
  id: BuildingId;
  type: BuildingType;
  tile: TileIndex;
  /** Adjacent road tile the occupants enter and leave from. */
  accessRoad: TileIndex;
  /**
   * Stations only: the adjacent rail tile trains stop at. -1 for everything
   * else. A station needs both this and `accessRoad` -- track to serve it and
   * a pavement for passengers to arrive on.
   */
  platform: TileIndex;
  capacity: number;
  occupants: CitizenId[];
  /**
   * Cleared on demolition. Ids are array indices used throughout the sim, so
   * buildings are tombstoned rather than spliced out. Stations legitimately
   * have zero capacity, so liveness needs its own flag.
   */
  alive: boolean;

  // --- Utilities -----------------------------------------------------------

  /** Set by the power grid each time it runs. Unpowered buildings do nothing. */
  powered: boolean;

  // --- Supply chain --------------------------------------------------------
  // Every building in the chain keeps two small stockpiles. Raw materials come
  // in, goods go out, and both are capped -- a warehouse that never fills
  // would let one farm feed a whole city, and the point of the chain is that
  // it can fail somewhere.

  /** Raw materials held. Factories consume these; primary industry has none. */
  rawStock: number;
  /** Finished goods held. Shops sell these; primary industry does not make them. */
  goodsStock: number;
  /** Units sold in the last accounting day, which is what commercial tax is on. */
  soldToday: number;
  /** Sim-hours this building has spent unable to get what it needs. */
  starvedHours: number;
}

/**
 * Everything that differs between building types, in one table.
 *
 * Keeping it as data rather than as branches means adding a building type is a
 * row, not a hunt through the simulation for every `switch` that needs a new
 * case -- and it makes the balance legible: the whole economy is these numbers
 * next to each other.
 */
export interface BuildingSpec {
  /** Residents for homes, jobs for workplaces. */
  capacity: number;
  industry: Industry;
  /** Power units drawn when operating. */
  power: number;
  /** Noise emitted at the building's own tile, before it spreads. */
  noise: number;
  /** Raw materials consumed per sim-hour when fully staffed. */
  rawPerHour: number;
  /** Output per sim-hour when fully staffed: goods, or raw for primary. */
  outputPerHour: number;
  /** How much of each stockpile the building can hold. */
  storage: number;
  /** Daily upkeep paid by the city. Private buildings cost the city nothing. */
  upkeep: number;
  /** Value produced per filled job per day, before tax. */
  wagePerJob: number;
}

const SPECS: Record<BuildingType, BuildingSpec> = {
  [BuildingType.House]: {
    capacity: 4, industry: Industry.None, power: 4, noise: 0,
    rawPerHour: 0, outputPerHour: 0, storage: 0, upkeep: 0, wagePerJob: 0,
  },
  // Four times the households on the same tile, for four times the power. The
  // whole point of the high-density zone is that it needs land worth living on.
  [BuildingType.Apartment]: {
    capacity: 16, industry: Industry.None, power: 16, noise: 1,
    rawPerHour: 0, outputPerHour: 0, storage: 0, upkeep: 0, wagePerJob: 0,
  },
  [BuildingType.Shop]: {
    capacity: 6, industry: Industry.Retail, power: 8, noise: 2,
    rawPerHour: 0, outputPerHour: 0, storage: 40, upkeep: 0, wagePerJob: 34,
  },
  [BuildingType.Factory]: {
    capacity: 10, industry: Industry.Secondary, power: 20, noise: 6,
    rawPerHour: 4, outputPerHour: 4, storage: 60, upkeep: 0, wagePerJob: 30,
  },
  // Offices are the quiet, well-paid, goods-free workplace: the reason to zone
  // an office district rather than more factories once land gets valuable.
  [BuildingType.Office]: {
    capacity: 12, industry: Industry.Tertiary, power: 12, noise: 1,
    rawPerHour: 0, outputPerHour: 0, storage: 0, upkeep: 0, wagePerJob: 52,
  },
  [BuildingType.Farm]: {
    capacity: 4, industry: Industry.Primary, power: 3, noise: 1,
    rawPerHour: 0, outputPerHour: 4, storage: 40, upkeep: 0, wagePerJob: 22,
  },
  [BuildingType.ForestryCamp]: {
    capacity: 4, industry: Industry.Primary, power: 3, noise: 3,
    rawPerHour: 0, outputPerHour: 4, storage: 40, upkeep: 0, wagePerJob: 24,
  },
  [BuildingType.FishingWharf]: {
    capacity: 4, industry: Industry.Primary, power: 3, noise: 2,
    rawPerHour: 0, outputPerHour: 4, storage: 40, upkeep: 0, wagePerJob: 24,
  },
  [BuildingType.Mine]: {
    capacity: 6, industry: Industry.Primary, power: 8, noise: 7,
    rawPerHour: 0, outputPerHour: 6, storage: 50, upkeep: 0, wagePerJob: 28,
  },
  [BuildingType.Station]: {
    capacity: 0, industry: Industry.None, power: 6, noise: 3,
    rawPerHour: 0, outputPerHour: 0, storage: 0, upkeep: 300, wagePerJob: 0,
  },
  [BuildingType.PowerPlant]: {
    capacity: 8, industry: Industry.None, power: 0, noise: 9,
    rawPerHour: 0, outputPerHour: 0, storage: 0, upkeep: 900, wagePerJob: 26,
  },
};

export function specFor(type: BuildingType): BuildingSpec {
  return SPECS[type];
}

export function capacityFor(type: BuildingType): number {
  return SPECS[type].capacity;
}

export function hasVacancy(b: Building): boolean {
  return b.occupants.length < b.capacity;
}

/** Homes hold residents; everything else holds workers. */
export function isHome(type: BuildingType): boolean {
  return type === BuildingType.House || type === BuildingType.Apartment;
}

export function isWorkplace(type: BuildingType): boolean {
  return !isHome(type) && SPECS[type].capacity > 0;
}

export function industryOf(type: BuildingType): Industry {
  return SPECS[type].industry;
}

/**
 * How much of its work a building is actually doing, in [0, 1].
 *
 * One number, used everywhere: it scales output, wages, power draw and noise.
 * A half-staffed factory in a blackout should not be paying full wages or
 * making full noise, and threading the same ratio through every consequence is
 * what keeps those from drifting apart.
 */
export function operatingRatio(b: Building): number {
  if (!b.alive || !b.powered) return 0;
  const spec = SPECS[b.type];
  if (spec.capacity === 0) return b.powered ? 1 : 0;
  return b.occupants.length / spec.capacity;
}

/** The building a zone grows, or null for zones that grow nothing. */
export function buildingForZone(zone: Zone): BuildingType | null {
  switch (zone) {
    case Zone.ResidentialLow:
      return BuildingType.House;
    case Zone.ResidentialHigh:
      return BuildingType.Apartment;
    case Zone.Commercial:
      return BuildingType.Shop;
    case Zone.Industrial:
      return BuildingType.Factory;
    case Zone.Office:
      return BuildingType.Office;
    case Zone.Farm:
      return BuildingType.Farm;
    case Zone.Forestry:
      return BuildingType.ForestryCamp;
    case Zone.Fishery:
      return BuildingType.FishingWharf;
    case Zone.Mining:
      return BuildingType.Mine;
    case Zone.None:
      return null;
  }
}
