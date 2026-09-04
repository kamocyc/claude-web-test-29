import { Vector3 } from 'three';
import type { SegmentId } from '../track/network/network';
import type { Lot, ZoneType } from '../track/network/zoning';
import { BuildingType, Industry } from '../core/types';
import { isCivic, specFor, type BuildingSpec } from '../world/buildings';
import type { CityWorld } from './world';

/**
 * The city's buildings, on the engine's plots.
 *
 * Two things have to be kept apart here, and keeping them together is what
 * would break. A **plot** is derived: the engine works out where a building
 * can stand every time the network changes, and a road moved by a metre
 * produces a different set of plots. A **building** is not: it holds the
 * people who live in it, the stock on its shelves and the hours it has spent
 * unable to work, and none of that may vanish because a street elsewhere was
 * re-laid.
 *
 * So a building remembers *where it stands*, and after every rebuild it is
 * matched back to whichever plot is still there. A building whose plot has
 * gone is demolished -- which is exactly the rule the tile city had, where
 * bulldozing a road took its buildings with it, and the reason is the same:
 * a building nobody can reach is not a building.
 */

/** How far a building may be from a plot's centre and still be that building. */
const REATTACH_RADIUS = 7;

export interface CityBuilding {
  id: number;
  type: BuildingType;
  zone: ZoneType;
  /** Where it stands. Survives re-laying; the plot does not. */
  at: Vector3;
  /** Index into the world's current lots, or -1 when its plot has gone. */
  lot: number;
  /** The road it is entered from, and where along it. */
  access: { segment: SegmentId; at: Vector3 } | null;

  capacity: number;
  occupants: number[];
  alive: boolean;
  powered: boolean;

  rawStock: number;
  goodsStock: number;
  soldToday: number;
  starvedHours: number;
  visitsToday: number;
}

/** What each painted use grows. The city's economy is keyed to these. */
export const ZONE_BUILDING: Record<ZoneType, BuildingType> = {
  residential: BuildingType.House,
  apartment: BuildingType.Apartment,
  commercial: BuildingType.Shop,
  office: BuildingType.Office,
  industrial: BuildingType.Factory,
  farm: BuildingType.Farm,
  forestry: BuildingType.ForestryCamp,
  fishery: BuildingType.FishingWharf,
  mining: BuildingType.Mine,
};

export function specOf(building: CityBuilding): BuildingSpec {
  return specFor(building.type);
}

export function industryOf(building: CityBuilding): Industry {
  return specFor(building.type).industry;
}

export function isHome(building: CityBuilding): boolean {
  return building.type === BuildingType.House || building.type === BuildingType.Apartment;
}

export function isWorkplace(building: CityBuilding): boolean {
  return !isHome(building) && building.capacity > 0;
}

export function hasVacancy(building: CityBuilding): boolean {
  return building.alive && building.occupants.length < building.capacity;
}

/** Put a building on a plot. The plot decides what it is; the spec, how big. */
export function createBuilding(id: number, lot: Lot, lotIndex: number): CityBuilding {
  const type = ZONE_BUILDING[lot.zone];
  const spec = specFor(type);
  return {
    id,
    type,
    zone: lot.zone,
    at: lot.center.clone(),
    lot: lotIndex,
    access: null,
    // A wider plot holds more of whatever it is. The spec is the figure for an
    // ordinary plot; a big frontage is worth roughly its width in extra
    // capacity, which is what makes zoning a whole block different from
    // zoning the strip along the kerb.
    capacity: Math.max(1, Math.round(spec.capacity * plotScale(lot))),
    occupants: [],
    alive: true,
    powered: false,
    rawStock: 0,
    goodsStock: 0,
    soldToday: 0,
    starvedHours: 0,
    visitsToday: 0,
  };
}

/** How much building a plot is worth, against an ordinary one-cell plot. */
export function plotScale(lot: Lot): number {
  return Math.max(0.6, Math.min(3, (lot.cells.wide * lot.cells.deep) / 2));
}

/**
 * Match the city's buildings back to the plots after a rebuild.
 *
 * Buildings that find a plot keep everything; buildings that do not are
 * demolished, and their residents are turned out (the caller re-houses them).
 * Returns the plots nobody claimed, which is where growth may build.
 */
export function reattachBuildings(
  world: CityWorld,
  buildings: CityBuilding[],
): { free: number[]; lost: CityBuilding[] } {
  const lots = world.lots;
  const claimed = new Set<number>();
  const lost: CityBuilding[] = [];

  // A coarse spatial index so re-attaching a thousand buildings does not
  // become a thousand passes over a thousand plots.
  const CELL = 24;
  const index = new Map<number, number[]>();
  const key = (x: number, z: number): number =>
    Math.floor(x / CELL) * 100_000 + Math.floor(z / CELL);
  lots.forEach((lot, i) => {
    const at = key(lot.center.x, lot.center.z);
    const bucket = index.get(at);
    if (bucket) bucket.push(i);
    else index.set(at, [i]);
  });

  for (const building of buildings) {
    if (!building.alive) continue;
    // The city's own buildings do not stand on plots and are never re-matched
    // to one: a hospital was put somewhere on purpose, and re-laying a street
    // two blocks away must not move it or knock it down.
    if (isCivic(building.type)) continue;
    let bestLot = -1;
    let bestDistance = REATTACH_RADIUS * REATTACH_RADIUS;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const bucket = index.get(key(building.at.x + dx * CELL, building.at.z + dz * CELL));
        if (!bucket) continue;
        for (const i of bucket) {
          if (claimed.has(i)) continue;
          const lot = lots[i];
          // The use must still match: painting a housing street industrial
          // replaces the houses rather than converting them.
          if (lot.zone !== building.zone) continue;
          const d = (lot.center.x - building.at.x) ** 2 + (lot.center.z - building.at.z) ** 2;
          if (d < bestDistance) {
            bestDistance = d;
            bestLot = i;
          }
        }
      }
    }

    if (bestLot < 0) {
      building.lot = -1;
      building.access = null;
      building.alive = false;
      lost.push(building);
      continue;
    }
    claimed.add(bestLot);
    const lot = lots[bestLot];
    building.lot = bestLot;
    building.at.copy(lot.center);
    building.access = { segment: lot.segment, at: lot.center.clone() };
    building.capacity = Math.max(1, Math.round(specFor(building.type).capacity * plotScale(lot)));
  }

  const free: number[] = [];
  lots.forEach((_, i) => {
    if (!claimed.has(i)) free.push(i);
  });
  return { free, lost };
}

/** The middle of a building's frontage, which is where a trip starts and ends. */
export function doorstep(world: CityWorld, building: CityBuilding): Vector3 | null {
  if (building.lot < 0) return null;
  const lot = world.lots[building.lot];
  if (!lot) return null;
  return lot.center.clone().addScaledVector(lot.outward, -lot.depth / 2);
}
