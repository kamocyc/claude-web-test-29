import { HOUSEHOLDS_PER_RESIDENCE, JOBS_PER_COMMERCE } from '../config';
import { BuildingType, type BuildingId, type CitizenId, type TileIndex } from '../core/types';

export interface Building {
  id: BuildingId;
  type: BuildingType;
  tile: TileIndex;
  /** Adjacent road tile the occupants enter and leave from. */
  accessRoad: TileIndex;
  capacity: number;
  occupants: CitizenId[];
}

export function capacityFor(type: BuildingType): number {
  return type === BuildingType.Residence ? HOUSEHOLDS_PER_RESIDENCE : JOBS_PER_COMMERCE;
}

export function hasVacancy(b: Building): boolean {
  return b.occupants.length < b.capacity;
}
