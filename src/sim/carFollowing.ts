import {
  CAR_ACCEL,
  CAR_DECEL_COMFORT,
  CAR_DECEL_MAX,
  CAR_LENGTH,
  CAR_MIN_GAP,
} from '../config';

/**
 * The car-following model. Pure functions over scalars, so the interesting
 * properties (no collisions, no overshoot past a stop line, monotone approach
 * to free speed) are directly testable without a world.
 *
 * Everything the player reads as "traffic" comes out of here. There is no
 * congestion coefficient anywhere in this codebase: a jam is what happens when
 * enough cars brake for the car in front, and the braking propagates backwards
 * on its own.
 */

/**
 * The fastest you can be going and still stop within `distance`.
 *
 * Note this is *not* the textbook sqrt(2ad). Positions are integrated as
 * `s += v` once per tick, so a car moves a whole tick at its current speed
 * before it gets to reconsider. Solving `v + v^2/(2a) <= d` instead of
 * `v^2/(2a) <= d` accounts for that first step, and is the difference between
 * cars that stop on the line and cars that creep through it every time.
 */
export function brakingSpeed(distance: number): number {
  if (distance <= 0) return 0;
  const a = CAR_DECEL_COMFORT;
  return Math.sqrt(a * a + 2 * a * distance) - a;
}

/**
 * Target speed as the tightest of three limits: the road's free speed, the
 * gap to the car ahead, and the distance to the next hard stop (a full tile,
 * or the end of the trip).
 */
export function desiredSpeed(
  freeSpeed: number,
  gapToLeader: number,
  distanceToStop: number,
): number {
  const clearance = gapToLeader - CAR_LENGTH - CAR_MIN_GAP;
  return Math.min(freeSpeed, brakingSpeed(clearance), brakingSpeed(distanceToStop));
}

/**
 * Integrate one tick of acceleration. Clamping the *change* rather than
 * snapping to the target is the whole reason cars pull away and slow down
 * smoothly instead of teleporting between speeds.
 */
export function stepSpeed(current: number, desired: number, freeSpeed: number): number {
  const delta = desired - current;
  const applied = delta >= 0
    ? Math.min(delta, CAR_ACCEL)
    : Math.max(delta, -CAR_DECEL_MAX);
  return Math.min(freeSpeed, Math.max(0, current + applied));
}

/**
 * How far ahead a car begins to react to a stop. Used to decide whether the
 * next tile's occupancy is worth looking at yet.
 */
export function lookaheadDistance(speed: number): number {
  return (speed * speed) / (2 * CAR_DECEL_COMFORT) + CAR_LENGTH + CAR_MIN_GAP + 1;
}
