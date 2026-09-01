import { HOUSEHOLDS_PER_RESIDENCE, JOBS_PER_COMMERCE } from '../config';
import { BuildingType, type BuildingId, type CitizenId, type TileIndex } from '../core/types';

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
}

export function capacityFor(type: BuildingType): number {
  switch (type) {
    case BuildingType.Residence:
      return HOUSEHOLDS_PER_RESIDENCE;
    case BuildingType.Commerce:
      return JOBS_PER_COMMERCE;
    case BuildingType.Station:
      return 0;
  }
}

export function hasVacancy(b: Building): boolean {
  return b.occupants.length < b.capacity;
}
