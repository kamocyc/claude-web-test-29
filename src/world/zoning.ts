import {
  BUILDINGS_PER_GROWTH_STEP,
  HOUSEHOLDS_PER_RESIDENCE,
  JOBS_PER_COMMERCE,
  MAX_POPULATION,
} from '../config';
import { manhattan } from '../core/grid';
import { BuildingType, Zone, type TileIndex } from '../core/types';
import { createCitizen } from '../sim/citizen';
import { hasVacancy, type Building } from './buildings';
import type { World } from './world';

/**
 * Growth is demand-driven in the simplest way that still produces a plausible
 * city: workplaces lead, housing follows the jobs they open up.
 *
 * The town keeps a standing surplus of vacant jobs (JOB_SURPLUS_RATIO of the
 * population). Without that buffer the two sides settle into exact balance --
 * no vacancies, so no new housing; nobody unemployed, so no new workplaces --
 * and the city stops dead a few buildings in. The surplus is what keeps the
 * loop turning until the zoned land or MAX_POPULATION runs out.
 */
const JOB_SURPLUS_RATIO = 0.15;

export function growCity(world: World): void {
  const vacantJobs = countVacantJobs(world);
  const targetSurplus = Math.max(
    JOBS_PER_COMMERCE,
    Math.ceil(world.population * JOB_SURPLUS_RATIO),
  );

  if (vacantJobs < targetSurplus) {
    grow(world, Zone.Commercial, BuildingType.Commerce, BUILDINGS_PER_GROWTH_STEP);
  }
  if (countVacantJobs(world) > 0 && world.population < MAX_POPULATION) {
    grow(world, Zone.Residential, BuildingType.Residence, BUILDINGS_PER_GROWTH_STEP);
  }

  assignJobs(world);
}

function grow(world: World, zone: Zone, type: BuildingType, limit: number): number {
  const candidates = collectZonedTiles(world, zone);
  if (candidates.length === 0) return 0;

  let built = 0;
  while (built < limit && candidates.length > 0) {
    const pick = world.rng.int(candidates.length);
    const tile = candidates[pick];
    candidates[pick] = candidates[candidates.length - 1];
    candidates.pop();

    const b = world.addBuilding(tile, type);
    if (!b) continue;
    built++;

    if (type === BuildingType.Residence) {
      populate(world, b);
    }
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

function populate(world: World, residence: Building): void {
  const room = Math.min(
    HOUSEHOLDS_PER_RESIDENCE,
    MAX_POPULATION - world.population,
  );
  for (let n = 0; n < room; n++) {
    const id = world.citizens.length;
    const citizen = createCitizen(id, residence.id, -1, residence.tile, world.rng);
    world.citizens.push(citizen);
    residence.occupants.push(id);
  }
}

/** Give every jobless citizen the nearest workplace that still has a slot. */
function assignJobs(world: World): void {
  const openings = world.buildings.filter(
    (b) => b.type === BuildingType.Commerce && world.isAlive(b) && hasVacancy(b),
  );
  if (openings.length === 0) return;

  for (const c of world.citizens) {
    if (c.work >= 0 && world.isAlive(world.buildings[c.work])) continue;

    const home = world.buildings[c.home];
    if (!home || !world.isAlive(home)) continue;

    let best: Building | null = null;
    let bestDist = Infinity;
    for (const b of openings) {
      if (!hasVacancy(b)) continue;
      const d = manhattan(home.tile, b.tile);
      if (d < bestDist) {
        bestDist = d;
        best = b;
      }
    }
    if (!best) return;

    best.occupants.push(c.id);
    c.work = best.id;
    c.path = null;
  }
}

function countVacantJobs(world: World): number {
  let n = 0;
  for (const b of world.buildings) {
    if (b.type === BuildingType.Commerce && world.isAlive(b)) {
      n += b.capacity - b.occupants.length;
    }
  }
  return n;
}

