import {
  LEISURE_JITTER_MINUTES,
  LEISURE_MINUTE,
  REST_DAYS_PER_WEEK,
  SCHEDULE_JITTER_MINUTES,
  SHOPPING_JITTER_MINUTES,
  SHOPPING_MINUTE,
  WORK_END_MINUTE,
  WORK_START_MINUTE,
} from '../config';
import { hashToUnit } from '../core/rng';
import { scheduleJitter } from './citizen';

const SALT_MORNING = 0x9e37;
const SALT_EVENING = 0x85eb;
const SALT_SHOPPING = 0xc2b2;
const SALT_LEISURE = 0x27d4;
const SALT_REST = 0x1656;

/**
 * Departure times are derived from the citizen's seed, not stored and not
 * drawn from the shared RNG, so they are stable across reloads, independent of
 * the order citizens are created in, and unaffected by anyone else moving out.
 */
export function departForWorkMinute(seed: number): number {
  return wrapDay(WORK_START_MINUTE + scheduleJitter(seed, SALT_MORNING) * SCHEDULE_JITTER_MINUTES);
}

export function departForHomeMinute(seed: number): number {
  return wrapDay(WORK_END_MINUTE + scheduleJitter(seed, SALT_EVENING) * SCHEDULE_JITTER_MINUTES);
}

/**
 * When this citizen prefers to do the shopping.
 *
 * Spread wider than the commute, because shopping has no start time to be
 * late for -- and because the whole point of the jitter is to stop the city
 * arriving at the same shop in the same hour and all coming home empty.
 */
export function shoppingMinute(seed: number): number {
  return wrapDay(SHOPPING_MINUTE + scheduleJitter(seed, SALT_SHOPPING) * SHOPPING_JITTER_MINUTES);
}

/**
 * When this citizen prefers to go out.
 *
 * Early afternoon rather than the evening, so leisure traffic falls between
 * the two commutes rather than on top of the shopping run -- which is the
 * point of having a third trip purpose at all: a different hour of the day
 * with a different pattern on the roads.
 */
export function leisureMinute(seed: number): number {
  return wrapDay(LEISURE_MINUTE + scheduleJitter(seed, SALT_LEISURE) * LEISURE_JITTER_MINUTES);
}

/**
 * The day of the week this citizen does not work, derived from their seed.
 *
 * Staggered rather than shared, so a seventh of the city is off on any given
 * day. A common weekend would empty every workplace at once and make the whole
 * economy lurch in a seven-day cycle that says nothing about how the city was
 * built; this gives the thing worth having -- somebody at home on a Tuesday
 * afternoon, going to the park -- without stopping the city.
 */
export function restDay(seed: number): number {
  return Math.floor(hashToUnit(seed, SALT_REST) * REST_DAYS_PER_WEEK) % REST_DAYS_PER_WEEK;
}

/** True when `day` is this citizen's day off. */
export function isRestDay(seed: number, day: number): boolean {
  return day % REST_DAYS_PER_WEEK === restDay(seed);
}

function wrapDay(m: number): number {
  const r = Math.round(m) % 1440;
  return r < 0 ? r + 1440 : r;
}

/**
 * True when `now` is inside the window that starts at `from` and runs for
 * `windowMinutes`, handling the midnight wrap. Using a window rather than an
 * equality test means a citizen never misses a departure because the clock
 * stepped past it while the game was fast-forwarded.
 */
export function inDepartureWindow(now: number, from: number, windowMinutes: number): boolean {
  const delta = (now - from + 1440) % 1440;
  return delta < windowMinutes;
}
