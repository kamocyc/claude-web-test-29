export type TileIndex = number;
export type BuildingId = number;
export type CitizenId = number;

export const enum Terrain {
  Grass = 0,
  Water = 1,
}

export const enum Zone {
  None = 0,
  Residential = 1,
  Commercial = 2,
}

export const enum BuildingType {
  Residence = 0,
  Commerce = 1,
}

export const enum CitizenState {
  AtHome = 0,
  ToWork = 1,
  AtWork = 2,
  ToHome = 3,
  /** No road route to the destination. Waits and retries. */
  Stranded = 4,
}

export const enum TravelMode {
  Walk = 0,
  Car = 1,
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
