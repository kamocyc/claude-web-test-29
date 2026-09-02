export type TileIndex = number;
export type BuildingId = number;
export type CitizenId = number;
export type LineId = number;
export type TrainId = number;

export const enum Terrain {
  Grass = 0,
  Water = 1,
}

/**
 * What a tile is naturally good for. Primary industry can only be zoned where
 * the ground supports it, which is what stops a city from being a uniform
 * sheet of interchangeable land: a paddy needs fertile ground by the river, a
 * mine needs the ore seam, a wharf needs the water.
 */
export const enum Resource {
  None = 0,
  /** Fertile ground, near the river. Paddy fields. */
  Fertile = 1,
  Forest = 2,
  Ore = 3,
}

export const enum Zone {
  None = 0,
  ResidentialLow = 1,
  ResidentialHigh = 2,
  Commercial = 3,
  Industrial = 4,
  Office = 5,
  Farm = 6,
  Forestry = 7,
  Fishery = 8,
  Mining = 9,
}

export const enum BuildingType {
  House = 0,
  Apartment = 1,
  Shop = 2,
  Factory = 3,
  Office = 4,
  Farm = 5,
  ForestryCamp = 6,
  FishingWharf = 7,
  Mine = 8,
  Station = 9,
  PowerPlant = 10,
}

/** What a building does in the supply chain. */
export const enum Industry {
  /** Houses, stations, power plants: no part in the chain. */
  None = 0,
  /** Farm, forestry, fishery, mine: produce raw materials from nothing. */
  Primary = 1,
  /** Factories: turn raw materials into goods. */
  Secondary = 2,
  /** Shops: sell goods to residents, which is where commercial tax comes from. */
  Retail = 3,
  /** Offices: employ people and produce neither, but pay well and are quiet. */
  Tertiary = 4,
}

export const enum CitizenState {
  AtHome = 0,
  ToWork = 1,
  AtWork = 2,
  ToHome = 3,
  /** No route to the destination. Waits and retries. */
  Stranded = 4,
  /** Standing on a platform, waiting for a train on their line. */
  Waiting = 5,
  /** Aboard a train. Position is the train's position. */
  Riding = 6,
  /** On the way to buy the household's groceries. */
  ToShop = 7,
  /** In the shop, filling the basket. */
  AtShop = 8,
}

/**
 * True while the citizen is somewhere they stay put: at home, at their desk,
 * or standing in a shop.
 *
 * Every "is this person out?" test in the codebase used to enumerate the
 * states it did not want, so each new state meant hunting through the
 * renderer, the statistics, the inspector and the selection code. These two
 * predicates are the single place that knowledge lives now.
 */
export function isAtRest(state: CitizenState): boolean {
  return (
    state === CitizenState.AtHome ||
    state === CitizenState.AtWork ||
    state === CitizenState.AtShop
  );
}

/** True while the citizen is out of the house on a trip, in any form. */
export function isEnRoute(state: CitizenState): boolean {
  return !isAtRest(state) && state !== CitizenState.Stranded;
}

/** True while the citizen is following a path of their own. */
export function isTravelling(state: CitizenState): boolean {
  return (
    state === CitizenState.ToWork ||
    state === CitizenState.ToHome ||
    state === CitizenState.ToShop
  );
}

/**
 * Where a leg ends. Journeys are named by where they are going, and arriving
 * turns that into where the citizen now is -- so the arrival handler does not
 * have to work it out by comparing the destination against the citizen's home
 * and workplace, which stops being a complete question the moment there is
 * somewhere else to go.
 */
export function arrivalStateFor(leg: CitizenState): CitizenState {
  switch (leg) {
    case CitizenState.ToWork:
      return CitizenState.AtWork;
    case CitizenState.ToShop:
      return CitizenState.AtShop;
    default:
      return CitizenState.AtHome;
  }
}

export const enum TravelMode {
  Walk = 0,
  Car = 1,
  /** A door-to-door trip that includes at least one train ride. */
  Transit = 2,
}

/** Index into DIRECTIONS. Used to keep opposing traffic in separate queues. */
export const enum Direction {
  North = 0,
  East = 1,
  South = 2,
  West = 3,
}

export const DIRECTIONS: ReadonlyArray<{ dx: number; dy: number }> = [
  { dx: 0, dy: -1 },
  { dx: 1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
];

export interface Vec2 {
  x: number;
  y: number;
}
