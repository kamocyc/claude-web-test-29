import {
  COMMUTE_MISERY_MINUTES,
  MAX_POPULATION,
  MOVE_IN_PER_HOUR,
  PATIENCE_HOURS,
  UNHAPPY_THRESHOLD,
} from '../config';
import { ticksToMinutes } from '../core/clock';
import { createCitizen, type Citizen } from './citizen';
import { hasVacancy, isHome, type Building } from '../world/buildings';
import type { World } from '../world/world';
import type { Economy } from './economy';
import type { LandValueField } from './landValue';
import type { NoiseField } from './noise';

/** Why the city is as happy or unhappy as it is, averaged over everyone. */
export interface HappinessBreakdown {
  overall: number;
  housing: number;
  commute: number;
  employment: number;
  services: number;
  power: number;
}

export interface MigrationReport {
  movedIn: number;
  movedOut: number;
}

/**
 * How the residents feel, and what they do about it.
 *
 * Happiness is deliberately assembled from things the player changed rather
 * than from a hidden curve: where the house is (land value and noise), how
 * long the commute took, whether there is a job, whether the shops have
 * anything to sell, and whether the lights are on. Each term is visible in the
 * inspector for one citizen and in the panel for the city, so an unhappy town
 * can always be read as a list of specific failures.
 *
 * It then feeds the only thing that really matters to a city builder: people
 * arrive when the place is worth moving to, and leave when it is not. The
 * population is not a number that only goes up.
 */
export class Happiness {
  breakdown: HappinessBreakdown = {
    overall: 50,
    housing: 50,
    commute: 50,
    employment: 50,
    services: 50,
    power: 100,
  };

  lastMigration: MigrationReport = { movedIn: 0, movedOut: 0 };

  /**
   * Recompute every citizen's happiness. Run once per sim hour: the inputs are
   * fields that themselves only move that fast.
   */
  update(
    world: World,
    landValue: LandValueField,
    noise: NoiseField,
    serviceLevel: number,
    economy: Economy,
    tick: number,
  ): void {
    // An empty town is judged on nothing, and dividing by nobody would make it
    // score zero -- which would mean the first resident could never arrive.
    // The default breakdown stands in until somebody lives here.
    if (world.citizens.length === 0) return;

    const totals = { housing: 0, commute: 0, employment: 0, services: 0, power: 0, overall: 0 };
    // An overdraft is the city visibly failing to pay for itself, and everyone
    // living in it notices.
    const civic = economy.inOverdraft ? -12 : 0;
    const serviceScore = serviceLevel * 100;

    for (const c of world.citizens) {
      const home = world.buildings[c.home];
      const housing = home && home.alive
        ? clamp(landValue.at(home.tile) - noise.at(home.tile) * 0.4)
        : 0;
      const commute = commuteScore(c, tick, employed(world, c));
      const employment = employed(world, c) ? 100 : 20;
      const powered = home && home.alive && home.powered ? 100 : 15;

      const score = clamp(
        housing * 0.3
        + commute * 0.2
        + employment * 0.2
        + serviceScore * 0.15
        + powered * 0.15
        + civic,
      );
      c.happiness = c.happiness === -1 ? score : c.happiness + (score - c.happiness) * 0.3;

      // Patience is what keeps a bad week from emptying the city. Only
      // sustained misery makes anyone actually leave.
      c.unhappyHours = c.happiness < UNHAPPY_THRESHOLD ? c.unhappyHours + 1 : 0;

      totals.housing += housing;
      totals.commute += commute;
      totals.employment += employment;
      totals.services += serviceScore;
      totals.power += powered;
      totals.overall += c.happiness;
    }

    const n = Math.max(1, world.citizens.length);
    this.breakdown = {
      overall: totals.overall / n,
      housing: totals.housing / n,
      commute: totals.commute / n,
      employment: totals.employment / n,
      services: totals.services / n,
      power: totals.power / n,
    };
  }

  /**
   * Move people in and out.
   *
   * Arrivals need somewhere to live *and* a reason to come: empty homes in a
   * miserable town stay empty, which is the failure mode a city builder should
   * be able to get into. Departures free both the home and the job, so a city
   * that drives people away visibly loses the workforce its businesses need.
   */
  migrate(world: World): MigrationReport {
    const report: MigrationReport = { movedIn: 0, movedOut: 0 };

    for (const c of world.citizens) {
      if (c.unhappyHours < PATIENCE_HOURS) continue;
      leave(world, c);
      report.movedOut++;
    }
    if (report.movedOut > 0) compactCitizens(world);

    // Below 35 the town is not worth moving to at all; by 75 it is as
    // attractive as it is going to get and arrivals are capped by the rate.
    const attractiveness = (this.breakdown.overall - 35) / 40;
    if (attractiveness > 0 && world.population < MAX_POPULATION) {
      const room = Math.min(
        Math.round(MOVE_IN_PER_HOUR * Math.min(1, attractiveness)),
        MAX_POPULATION - world.population,
      );
      report.movedIn = moveIn(world, room);
    }

    this.lastMigration = report;
    return report;
  }
}

/** Fill vacant dwellings, nearest-to-empty first, with brand new citizens. */
function moveIn(world: World, wanted: number): number {
  if (wanted <= 0) return 0;
  let moved = 0;

  for (const b of world.buildings) {
    if (moved >= wanted) break;
    if (!b.alive || !isHome(b.type) || !hasVacancy(b)) continue;

    while (moved < wanted && hasVacancy(b)) {
      const id = world.citizens.length;
      world.citizens.push(createCitizen(id, b.id, -1, b.tile, world.rng, world.nextCitizenSeed++));
      b.occupants.push(id);
      moved++;
    }
  }
  return moved;
}

/** Take a citizen out of their home and job, and mark them gone. */
function leave(world: World, c: Citizen): void {
  detach(world.buildings[c.home], c.id);
  detach(world.buildings[c.work], c.id);
  c.left = true;
}

function detach(b: Building | undefined, id: number): void {
  if (!b) return;
  const at = b.occupants.indexOf(id);
  if (at >= 0) b.occupants.splice(at, 1);
}

/**
 * Actually remove departed citizens, renumbering the survivors.
 *
 * Citizen ids are array indices used by buildings and trains, so this is the
 * one place in the simulation that has to renumber -- and it is why departures
 * are batched into a single hourly pass rather than done the moment somebody
 * gives up. Buildings hold ids, trains hold ids, and both are rewritten here
 * from the same map, so there is exactly one place to get it right.
 */
function compactCitizens(world: World): void {
  const remap = new Map<number, number>();
  const survivors: Citizen[] = [];

  for (const c of world.citizens) {
    if (c.left) continue;
    remap.set(c.id, survivors.length);
    c.id = survivors.length;
    survivors.push(c);
  }
  world.citizens.length = 0;
  world.citizens.push(...survivors);

  for (const b of world.buildings) {
    if (b.occupants.length === 0) continue;
    b.occupants = b.occupants.map((id) => remap.get(id) ?? -1).filter((id) => id >= 0);
  }
  for (const train of world.trains) {
    if (train.passengers.length === 0) continue;
    train.passengers = train.passengers
      .map((id) => remap.get(id) ?? -1)
      .filter((id) => id >= 0);
  }
  // Riders whose citizen id moved are still aboard; their `boardedTrain` is
  // unchanged, and the train's list above was rewritten to match.
  world.revision++;
}

function employed(world: World, c: Citizen): boolean {
  return c.work >= 0 && world.isAlive(world.buildings[c.work]);
}

/**
 * A commute nobody notices scores full marks; one that eats a third of the
 * day scores nothing. Based on the trip that actually happened rather than on
 * distance, so a jam the player caused shows up here.
 *
 * Somebody with no job to go to scores neutral rather than well. Crediting
 * them with a perfect commute would mean a city that had lost all its
 * employers scored *better* on travel the worse it got.
 */
function commuteScore(c: Citizen, tick: number, hasWork: boolean): number {
  if (!hasWork) return 50;
  const minutes = c.lastTripTicks > 0
    ? ticksToMinutes(c.lastTripTicks)
    : ticksToMinutes(Math.max(0, tick - c.tripStartTick));
  if (minutes <= 0) return 80;
  const ratio = Math.min(1, minutes / COMMUTE_MISERY_MINUTES);
  return clamp(100 - ratio * 100);
}

function clamp(v: number): number {
  return Math.min(100, Math.max(0, v));
}

/** Homes that exist but nobody has moved into yet. */
export function vacantDwellings(world: World): number {
  let n = 0;
  for (const b of world.buildings) {
    if (b.alive && isHome(b.type)) n += b.capacity - b.occupants.length;
  }
  return n;
}
