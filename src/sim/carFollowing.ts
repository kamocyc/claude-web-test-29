import {
  BUS_ACCEL,
  BUS_DECEL_COMFORT,
  BUS_DECEL_MAX,
  BUS_FREE_SPEED,
  BUS_LENGTH,
  BUS_MIN_GAP,
  CAR_ACCEL,
  CAR_DECEL_COMFORT,
  CAR_DECEL_MAX,
  CAR_FREE_SPEED,
  CAR_LENGTH,
  CAR_MIN_GAP,
  LORRY_ACCEL,
  LORRY_DECEL_COMFORT,
  LORRY_DECEL_MAX,
  LORRY_FREE_SPEED,
  LORRY_LENGTH,
  LORRY_MIN_GAP,
  TRAIN_ACCEL,
  TRAIN_DECEL_COMFORT,
  TRAIN_FREE_SPEED,
  TRAIN_LENGTH,
  TRAIN_MIN_GAP,
} from '../config';

/**
 * The parameters a following vehicle obeys. Cars and trains run the exact same
 * model with different numbers -- which is why a train pulls out of a platform
 * and eases into the next one as smoothly as a car does at a junction.
 */
export interface FollowingProfile {
  freeSpeed: number;
  accel: number;
  decelComfort: number;
  decelMax: number;
  length: number;
  minGap: number;
}

export const CAR_PROFILE: FollowingProfile = {
  freeSpeed: CAR_FREE_SPEED,
  accel: CAR_ACCEL,
  decelComfort: CAR_DECEL_COMFORT,
  decelMax: CAR_DECEL_MAX,
  length: CAR_LENGTH,
  minGap: CAR_MIN_GAP,
};

/**
 * A lorry: slower away from the lights, longer, and lower-geared than a car.
 *
 * The numbers are not there for realism so much as for consequence. A lorry
 * that took up the same road space as a car would be invisible in a queue,
 * and freight that moved at car speed would make distance almost free -- and
 * the whole point of putting goods on the road is that where the industry
 * sits should cost something.
 */
export const LORRY_PROFILE: FollowingProfile = {
  freeSpeed: LORRY_FREE_SPEED,
  accel: LORRY_ACCEL,
  decelComfort: LORRY_DECEL_COMFORT,
  decelMax: LORRY_DECEL_MAX,
  length: LORRY_LENGTH,
  minGap: LORRY_MIN_GAP,
};

/**
 * A bus: between a car and a lorry in every number.
 *
 * It cruises at car speed, because a vehicle that cannot be overtaken and
 * runs below the traffic is a rolling roadblock rather than a service -- the
 * same lesson the lorries taught. What makes it a bus rather than a big car is
 * that it is slow away from a stop and takes up half again the road space, so
 * a route down a narrow arterial is felt by everyone else on it.
 */
export const BUS_PROFILE: FollowingProfile = {
  freeSpeed: BUS_FREE_SPEED,
  accel: BUS_ACCEL,
  decelComfort: BUS_DECEL_COMFORT,
  decelMax: BUS_DECEL_MAX,
  length: BUS_LENGTH,
  minGap: BUS_MIN_GAP,
};

export const TRAIN_PROFILE: FollowingProfile = {
  freeSpeed: TRAIN_FREE_SPEED,
  accel: TRAIN_ACCEL,
  decelComfort: TRAIN_DECEL_COMFORT,
  // Trains have no emergency stop worth modelling; comfort braking is the cap.
  decelMax: TRAIN_DECEL_COMFORT,
  length: TRAIN_LENGTH,
  minGap: TRAIN_MIN_GAP,
};

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
export function brakingSpeed(distance: number, decel = CAR_DECEL_COMFORT): number {
  if (distance <= 0) return 0;
  return Math.sqrt(decel * decel + 2 * decel * distance) - decel;
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
  profile: FollowingProfile = CAR_PROFILE,
): number {
  const clearance = gapToLeader - profile.length - profile.minGap;
  return Math.min(
    freeSpeed,
    brakingSpeed(clearance, profile.decelComfort),
    brakingSpeed(distanceToStop, profile.decelComfort),
  );
}

/**
 * Integrate one tick of acceleration. Clamping the *change* rather than
 * snapping to the target is the whole reason cars pull away and slow down
 * smoothly instead of teleporting between speeds.
 */
export function stepSpeed(
  current: number,
  desired: number,
  freeSpeed: number,
  profile: FollowingProfile = CAR_PROFILE,
): number {
  const delta = desired - current;
  const applied = delta >= 0
    ? Math.min(delta, profile.accel)
    : Math.max(delta, -profile.decelMax);
  return Math.min(freeSpeed, Math.max(0, current + applied));
}

/**
 * How far ahead a car begins to react to a stop. Used to decide whether the
 * next tile's occupancy is worth looking at yet.
 */
export function lookaheadDistance(speed: number): number {
  return (speed * speed) / (2 * CAR_DECEL_COMFORT) + CAR_LENGTH + CAR_MIN_GAP + 1;
}
