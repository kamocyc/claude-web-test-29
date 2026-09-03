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

  // --- Leisure -------------------------------------------------------------

  /**
   * Visitors a leisure venue has taken today, reset with the day's books.
   *
   * The crowding counter, and the one honest way to show a player that their
   * one big stadium is not serving the city: it is the same figure the venue
   * turns people away on.
   */
  visitsToday: number;
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
  // A stop is a shelter: no staff, almost no power, and an upkeep small
  // enough that a dense network of them is affordable -- which is the whole
  // argument for buses over rail.
  [BuildingType.BusStop]: {
    capacity: 0, industry: Industry.None, power: 1, noise: 1,
    rawPerHour: 0, outputPerHour: 0, storage: 0, upkeep: 60, wagePerJob: 0,
  },
  // The three civic services are workplaces the city pays for rather than
  // taxes: their industry is None, so they are never charged commercial or
  // industrial tax, but their staff pay income tax like anybody else. What
  // they cost the city is the upkeep, and that is deliberately the largest in
  // the table -- a fire brigade is a standing expense, not a purchase.
  [BuildingType.School]: {
    capacity: 12, industry: Industry.None, power: 12, noise: 2,
    rawPerHour: 0, outputPerHour: 0, storage: 0, upkeep: 1_000, wagePerJob: 40,
  },
  [BuildingType.FireStation]: {
    capacity: 8, industry: Industry.None, power: 10, noise: 2,
    rawPerHour: 0, outputPerHour: 0, storage: 0, upkeep: 900, wagePerJob: 38,
  },
  [BuildingType.PoliceStation]: {
    capacity: 8, industry: Industry.None, power: 10, noise: 2,
    rawPerHour: 0, outputPerHour: 0, storage: 0, upkeep: 850, wagePerJob: 38,
  },
  [BuildingType.Hospital]: {
    capacity: 16, industry: Industry.None, power: 22, noise: 3,
    rawPerHour: 0, outputPerHour: 0, storage: 0, upkeep: 1_500, wagePerJob: 44,
  },
  // The three leisure venues. A park has no staff, no power worth speaking of
  // and no noise -- it is the one civic building that only ever improves the
  // ground it stands on, which is why it is also the cheapest. The two big
  // venues are the opposite: they employ people, draw the whole city across
  // town and are loud enough that where they go is a real decision.
  [BuildingType.Park]: {
    capacity: 0, industry: Industry.None, power: 1, noise: 0,
    rawPerHour: 0, outputPerHour: 0, storage: 0, upkeep: 120, wagePerJob: 0,
  },
  [BuildingType.Stadium]: {
    capacity: 14, industry: Industry.None, power: 24, noise: 7,
    rawPerHour: 0, outputPerHour: 0, storage: 0, upkeep: 2_100, wagePerJob: 32,
  },
  [BuildingType.AmusementPark]: {
    capacity: 20, industry: Industry.None, power: 30, noise: 6,
    rawPerHour: 0, outputPerHour: 0, storage: 0, upkeep: 3_200, wagePerJob: 30,
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
 * True for the buildings the player places directly rather than zoning for:
 * transport and the civic services. They are the city's own property, which
 * is why they carry upkeep and why demand never builds or abandons them.
 */
export function isCivic(type: BuildingType): boolean {
  return type === BuildingType.Station
    || type === BuildingType.PowerPlant
    || type === BuildingType.BusStop
    || type === BuildingType.School
    || type === BuildingType.FireStation
    || type === BuildingType.PoliceStation
    || type === BuildingType.Hospital
    || isLeisure(type);
}

/** True for the three places people go in their own time. */
export function isLeisure(type: BuildingType): boolean {
  return type === BuildingType.Park
    || type === BuildingType.Stadium
    || type === BuildingType.AmusementPark;
}

/**
 * How far a venue pulls people, and how much good one visit does them.
 *
 * One number does both jobs on purpose. A visit is worth `LEISURE_VISIT` days
 * of recreation scaled by the draw, and the same draw divided by distance is
 * what decides where somebody goes -- so a venue that is worth travelling for
 * is, by construction, a venue that is worth having travelled to. Splitting
 * them would let a building be attractive and disappointing at once, which is
 * a bug rather than a design.
 */
export function leisureDraw(type: BuildingType): number {
  switch (type) {
    case BuildingType.Park:
      return 1;
    case BuildingType.Stadium:
      return 2.4;
    case BuildingType.AmusementPark:
      return 3.4;
    default:
      return 0;
  }
}

/**
 * How many visits a venue can take in a day before it is simply full.
 *
 * A park is small and there are meant to be many of them; the fairground
 * takes ten times as many people and still cannot serve a whole city, which
 * is what stops one expensive building from answering the question forever.
 */
export function leisureCapacity(type: BuildingType): number {
  switch (type) {
    case BuildingType.Park:
      return 40;
    case BuildingType.Stadium:
      return 220;
    case BuildingType.AmusementPark:
      return 360;
    default:
      return 0;
  }
}

/** True for the two stations that keep emergency vehicles in the yard. */
export function isEmergencyStation(type: BuildingType): boolean {
  return type === BuildingType.FireStation || type === BuildingType.PoliceStation;
}

/** True for a stop or a station: somewhere a transit line can call. */
export function isTransitStop(type: BuildingType): boolean {
  return type === BuildingType.Station || type === BuildingType.BusStop;
}

/**
 * Whether this building is doing its job well enough to count as a service.
 *
 * A school with no teachers and no electricity is a building, not a school --
 * and saying so here rather than in each of the three services means the
 * coverage map, the crime field and the fire brigade cannot disagree about
 * which stations are actually running.
 */
export function isServing(b: Building): boolean {
  return b.alive && b.powered && operatingRatio(b) > 0;
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
