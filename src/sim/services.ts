import {
  FIRE_REACH_TILES,
  HOSPITAL_REACH_TILES,
  MAP_SIZE,
  SCHOOL_REACH_TILES,
} from '../config';
import { neighbors } from '../core/grid';
import { BuildingType, type TileIndex } from '../core/types';
import { isHome, isLeisure, isServing, type Building } from '../world/buildings';
import type { World } from '../world/world';

/** The services whose coverage is a question of "can it reach you by road?". */
export const enum Service {
  School = 0,
  Fire = 1,
  /** A hospital: the same question -- can it be got to along a road? */
  Health = 2,
}

/** The three catchment services, for anything that loops over them. */
export const REACH_SERVICES: readonly Service[] = [
  Service.School,
  Service.Fire,
  Service.Health,
];

const REACH: Record<Service, number> = {
  [Service.School]: SCHOOL_REACH_TILES,
  [Service.Fire]: FIRE_REACH_TILES,
  [Service.Health]: HOSPITAL_REACH_TILES,
};

const STATIONS: Record<Service, BuildingType> = {
  [Service.School]: BuildingType.School,
  [Service.Fire]: BuildingType.FireStation,
  [Service.Health]: BuildingType.Hospital,
};

export interface ServicesReport {
  schools: number;
  fireStations: number;
  policeStations: number;
  hospitals: number;
  /** Leisure: pocket parks, and the two big venues. */
  parks: number;
  venues: number;
  /** Visitors the venues have taken today, across the city. */
  leisureVisits: number;
  /** Households whose last outing found the place full. */
  turnedAway: number;
  /** Homes within reach of each service, and how many there are in total. */
  homes: number;
  schooled: number;
  fireCovered: number;
  healthCovered: number;
  /** Mean education of the population, 0..100. */
  education: number;
  /** Mean health of the population, 0..100. */
  health: number;
}

/**
 * Which parts of the city a school or a fire station can actually reach.
 *
 * Measured over the road network rather than as the crow flies, and for the
 * same reason the power grid is: what matters is whether the thing can be
 * got to. A school on the far bank of the river teaches nobody until somebody
 * builds a bridge, and a fire station three tiles away across the water is a
 * fire station that will watch the building burn.
 *
 * The hospital joined the two of them rather than becoming a fourth kind of
 * thing, because the question it answers is the same one: can it be got to?
 * What differs is what being covered *does* -- see `health.ts`.
 *
 * Police are deliberately *not* here. Policing is not a catchment -- it is how
 * safe a neighbourhood feels, which is a field that spreads and fades (see
 * `crime.ts`). Modelling all three the same way would have been simpler and
 * would have made three different things into one thing.
 */
export class Services {
  /** Per road tile: is this within reach of a working station of that kind? */
  private readonly reach: Record<Service, Uint8Array> = {
    [Service.School]: new Uint8Array(MAP_SIZE * MAP_SIZE),
    [Service.Fire]: new Uint8Array(MAP_SIZE * MAP_SIZE),
    [Service.Health]: new Uint8Array(MAP_SIZE * MAP_SIZE),
  };

  report: ServicesReport = emptyReport();

  update(world: World): void {
    for (const service of REACH_SERVICES) this.flood(world, service);
    this.publish(world);
  }

  /** True when a road tile is within reach of that service. */
  covers(service: Service, tile: TileIndex): boolean {
    return tile >= 0 && this.reach[service][tile] === 1;
  }

  /** True when a building's own doorstep is within reach. */
  serves(service: Service, b: Building): boolean {
    return this.covers(service, b.accessRoad);
  }

  /**
   * A breadth-first flood out from every working station at once, stopping at
   * the reach limit.
   *
   * One search for all the stations rather than one per station: the answer
   * wanted is "is this tile within reach of *any* of them", and a multi-source
   * flood computes exactly that in a single pass over the road network however
   * many stations the city has.
   */
  private flood(world: World, service: Service): void {
    const reach = this.reach[service];
    reach.fill(0);

    const limit = REACH[service];
    const distance = new Int16Array(MAP_SIZE * MAP_SIZE).fill(-1);
    let frontier: TileIndex[] = [];

    for (const b of world.buildings) {
      if (b.type !== STATIONS[service] || !isServing(b)) continue;
      world.refreshAccess(b);
      const start = b.accessRoad;
      if (start < 0 || distance[start] >= 0) continue;
      distance[start] = 0;
      reach[start] = 1;
      frontier.push(start);
    }

    for (let d = 0; d < limit && frontier.length > 0; d++) {
      const next: TileIndex[] = [];
      for (const tile of frontier) {
        for (const n of neighbors(tile)) {
          if (!world.map.isRoad(n) || distance[n] >= 0) continue;
          distance[n] = d + 1;
          reach[n] = 1;
          next.push(n);
        }
      }
      frontier = next;
    }
  }

  private publish(world: World): void {
    let schools = 0;
    let fireStations = 0;
    let policeStations = 0;
    let hospitals = 0;
    let parks = 0;
    let venues = 0;
    let leisureVisits = 0;
    let homes = 0;
    let schooled = 0;
    let fireCovered = 0;
    let healthCovered = 0;

    for (const b of world.buildings) {
      if (!b.alive) continue;
      if (b.type === BuildingType.School) schools++;
      else if (b.type === BuildingType.FireStation) fireStations++;
      else if (b.type === BuildingType.PoliceStation) policeStations++;
      else if (b.type === BuildingType.Hospital) hospitals++;
      else if (isLeisure(b.type)) {
        leisureVisits += b.visitsToday;
        if (b.type === BuildingType.Park) parks++;
        else venues++;
      }
      if (!isHome(b.type)) continue;
      homes++;
      if (this.serves(Service.School, b)) schooled++;
      if (this.serves(Service.Fire, b)) fireCovered++;
      if (this.serves(Service.Health, b)) healthCovered++;
    }

    let education = 0;
    let health = 0;
    let turnedAway = 0;
    for (const c of world.citizens) {
      education += c.education;
      health += c.health;
      if (c.lastOutingFailed) turnedAway++;
    }
    const people = Math.max(1, world.citizens.length);

    this.report = {
      schools,
      fireStations,
      policeStations,
      hospitals,
      parks,
      venues,
      leisureVisits,
      turnedAway,
      homes,
      schooled,
      fireCovered,
      healthCovered,
      education: world.citizens.length === 0 ? 0 : education / people,
      health: world.citizens.length === 0 ? 0 : health / people,
    };
  }
}

function emptyReport(): ServicesReport {
  return {
    schools: 0,
    fireStations: 0,
    policeStations: 0,
    hospitals: 0,
    parks: 0,
    venues: 0,
    leisureVisits: 0,
    turnedAway: 0,
    homes: 0,
    schooled: 0,
    fireCovered: 0,
    healthCovered: 0,
    education: 0,
    health: 0,
  };
}
