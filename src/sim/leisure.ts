import {
  ORDINANCE_GREENING_DRAW as GREENING_DRAW,
  LEISURE_CANDIDATES,
  LEISURE_DISTANCE_BIAS,
  LEISURE_DRAIN_PER_HOUR,
  LEISURE_SEARCH_RADIUS,
  LEISURE_TRIGGER,
  LEISURE_VISIT,
  LEISURE_VISITS_PER_CAPACITY,
} from '../config';
import { manhattan } from '../core/grid';
import { BuildingType, type BuildingId } from '../core/types';
import {
  isLeisure,
  isServing,
  leisureCapacity,
  leisureDraw,
  type Building,
} from '../world/buildings';
import type { World } from '../world/world';
import type { Citizen } from './citizen';
import type { Policies } from './policies';
import { Ordinance } from './policies';

/**
 * The third reason to leave the house: a park, a stadium, the fairground.
 *
 * Deliberately built the same way shopping is, because it is the same kind of
 * thing -- a household appetite that only a *trip* can satisfy. Modelling
 * leisure as "a park within N tiles adds happiness" would have been a tenth of
 * this file and would have made parks invisible: nobody would go anywhere, the
 * roads would be empty at three in the afternoon, and a fairground on the far
 * bank would be worth exactly as much as one next door.
 *
 * What differs from shopping is the *shape of the choice*. Groceries are a
 * commodity, so people take the nearest shop with anything on the shelf; a day
 * out is not, so a venue's draw is weighed against the journey. That single
 * difference is what makes a big venue worth building at all, and it is why
 * the two files are not one.
 */

/** Where this citizen would go for an outing, or -1 if nowhere is worth it. */
export function chooseVenue(world: World, c: Citizen, policies?: Policies): BuildingId {
  const home = world.buildings[c.home];
  if (!home || !home.alive) return -1;

  const candidates: Array<{ venue: Building; score: number }> = [];
  for (const b of world.buildings) {
    if (!b.alive || !isLeisure(b.type)) continue;
    // A venue with no electricity and -- for the staffed ones -- nobody
    // working there is a building, not a day out. The same test the schools
    // and the fire stations answer to.
    if (!isServing(b)) continue;
    if (isFull(b)) continue;

    const d = manhattan(b.tile, home.tile);
    if (d > LEISURE_SEARCH_RADIUS) continue;
    candidates.push({ venue: b, score: appeal(b, d, policies) });
  }
  if (candidates.length === 0) return -1;

  // Best few by appeal, then the closest of those: the shortlist is what a
  // person actually does -- a couple of places worth going, and then whichever
  // is nearest. Taking the single highest score outright sent every household
  // in the city to the same fairground on the same afternoon.
  candidates.sort((a, b) => (b.score - a.score) || (a.venue.id - b.venue.id));
  const shortlist = candidates.slice(0, LEISURE_CANDIDATES);
  let best = shortlist[0];
  let bestDistance = Infinity;
  for (const entry of shortlist) {
    const d = manhattan(entry.venue.tile, home.tile);
    if (d < bestDistance) {
      bestDistance = d;
      best = entry;
    }
  }
  return best.venue.id;
}

/**
 * How attractive a venue is from `distance` tiles away.
 *
 * At the bias distance a venue has to be twice as good to be worth the extra
 * journey, which is what keeps the local park competitive with the stadium
 * without making the stadium pointless.
 */
function appeal(b: Building, distance: number, policies?: Policies): number {
  const draw = drawOf(b, policies);
  return draw / (1 + distance / LEISURE_DISTANCE_BIAS);
}

/** A venue's pull, with the greening by-law in it if the city has passed one. */
export function drawOf(b: Building, policies?: Policies): number {
  return leisureDraw(b.type) * (policies?.isOn(Ordinance.Greening) ? GREENING_DRAW : 1);
}

/** True when a venue has already taken as many visitors as it can in a day. */
function isFull(b: Building): boolean {
  return b.visitsToday >= leisureCapacity(b.type) * LEISURE_VISITS_PER_CAPACITY;
}

/**
 * Spend the afternoon somewhere. Returns the recreation actually gained, which
 * is nothing at all if the place turned out to be full by the time they
 * arrived -- the leisure equivalent of walking to a shop and finding it bare,
 * and just as much a real outcome.
 */
export function visit(b: Building, c: Citizen, policies?: Policies): number {
  if (!b.alive || !isServing(b) || isFull(b)) {
    c.lastOutingFailed = true;
    return 0;
  }
  b.visitsToday++;
  const gained = LEISURE_VISIT * Math.min(1.5, drawOf(b, policies));
  c.leisure = Math.min(LEISURE_VISIT * 1.5, c.leisure + gained);
  c.lastOutingFailed = false;
  return gained;
}

/**
 * How well this citizen feels they get out, 0..1.
 *
 * Scored against the trigger rather than against a full stock, for the same
 * reason shopping is: somebody who went out yesterday and has two days in hand
 * is *fine*, and marking them down would report a well-provided city as a
 * miserable one. A wasted trip counts against it, because arriving at a
 * fairground that is full is exactly the experience this is meant to catch.
 */
export function leisureSatisfaction(c: Citizen): number {
  const stocked = Math.min(1, c.leisure / LEISURE_TRIGGER);
  return c.lastOutingFailed ? stocked * 0.6 : stocked;
}

/** Drain everybody's stock by an hour. Run with the rest of the slow city. */
export function drainLeisure(world: World): void {
  for (const c of world.citizens) {
    c.leisure = Math.max(0, c.leisure - LEISURE_DRAIN_PER_HOUR);
  }
}

/** Clear the crowding counters when the day's books close. */
export function endLeisureDay(world: World): void {
  for (const b of world.buildings) {
    if (b.visitsToday !== 0) b.visitsToday = 0;
  }
}

export interface LeisureReport {
  /** Venues, by kind. */
  parks: number;
  venues: number;
  /** Visits taken today across the city, and how many were turned away. */
  visitsToday: number;
  /** Mean satisfaction over the population, 0..100. */
  satisfaction: number;
  /** Households whose last outing found the place full. */
  turnedAway: number;
}

/** What the panels show: the city's leisure provision, in one pass. */
export function leisureReport(world: World): LeisureReport {
  let parks = 0;
  let venues = 0;
  let visitsToday = 0;
  for (const b of world.buildings) {
    if (!b.alive || !isLeisure(b.type)) continue;
    visitsToday += b.visitsToday;
    if (b.type === BuildingType.Park) parks++;
    else venues++;
  }

  let satisfaction = 0;
  let turnedAway = 0;
  for (const c of world.citizens) {
    satisfaction += leisureSatisfaction(c);
    if (c.lastOutingFailed) turnedAway++;
  }
  return {
    parks,
    venues,
    visitsToday,
    satisfaction: world.citizens.length === 0
      ? 0
      : (satisfaction / world.citizens.length) * 100,
    turnedAway,
  };
}
