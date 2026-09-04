/**
 * The city's clock, and the one number that converts between it and the
 * world the vehicles move in.
 *
 * In its own file because both the simulation and the transit planner have to
 * agree on it, and they cannot import each other. That agreement is not a
 * detail: the traffic model measures everything in seconds of world time and
 * the city measures everything in sim minutes, so any comparison between "how
 * long the drive takes" and "how long the journey takes" has to pass through
 * here. Two places once did that conversion by hand, with different constants,
 * and the result was that no car owner ever took a train.
 */

/**
 * Sim minutes per second of world time at x1.
 *
 * This is the exchange rate between the clock and the physics, and it is the
 * one number that decides whether a commute reads as a commute. The vehicles
 * move at real speeds -- a small road is 12 m/s -- so at one minute per second
 * a kilometre of driving took eighty minutes of the day and a five hundred
 * metre walk took six hours, which is not a city, it is a diorama with a
 * broken clock. At a sixth of that, a drive across the town is a quarter of an
 * hour and the walk is an hour: still generous to the car, but the shape of a
 * real journey, and the shape is what the player is deciding about.
 *
 * A day is 8640 seconds of world time, which is two and a half hours at x1 and
 * under five minutes at x30 -- hence the two fast settings.
 */
export const SIM_MINUTES_PER_SECOND = 1 / 6;

export const SPEEDS = [0, 1, 3, 10, 30] as const;
export const DEFAULT_SPEED = 3;

/** The time of day a new city opens at [sim minutes]. */
export const OPENING_MINUTE = 6 * 60;

/** Seconds of world time, as the city's own minutes. */
export function simMinutes(worldSeconds: number): number {
  return worldSeconds * SIM_MINUTES_PER_SECOND;
}
