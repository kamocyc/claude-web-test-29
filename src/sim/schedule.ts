import {
  SCHEDULE_JITTER_MINUTES,
  WORK_END_MINUTE,
  WORK_START_MINUTE,
} from '../config';
import { scheduleJitter } from './citizen';
import type { CitizenId } from '../core/types';

const SALT_MORNING = 0x9e37;
const SALT_EVENING = 0x85eb;

/**
 * Departure times are derived from the citizen id, not stored and not drawn
 * from the shared RNG, so they are stable across reloads and independent of
 * the order citizens are created in.
 */
export function departForWorkMinute(id: CitizenId): number {
  return wrapDay(WORK_START_MINUTE + scheduleJitter(id, SALT_MORNING) * SCHEDULE_JITTER_MINUTES);
}

export function departForHomeMinute(id: CitizenId): number {
  return wrapDay(WORK_END_MINUTE + scheduleJitter(id, SALT_EVENING) * SCHEDULE_JITTER_MINUTES);
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
