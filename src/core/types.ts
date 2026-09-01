export type TileIndex = number;
export type BuildingId = number;
export type CitizenId = number;
export type LineId = number;
export type TrainId = number;

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
  Station = 2,
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
}

/** True while the citizen is out of the house on a trip, in any form. */
export function isEnRoute(state: CitizenState): boolean {
  return (
    state === CitizenState.ToWork ||
    state === CitizenState.ToHome ||
    state === CitizenState.Waiting ||
    state === CitizenState.Riding
  );
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
