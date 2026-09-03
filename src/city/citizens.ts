import { Vector3 } from 'three';
import { hashToUnit, Rng } from '../core/rng';
import type { Vehicle } from '../track/sim/traffic';
import type { LaneRoute } from './routing';

/**
 * The people.
 *
 * Carried over from the tile city almost unchanged, because nothing about a
 * citizen was ever about tiles: they have a home, a job, an hour they leave
 * the house and an opinion about how it went. What changed is underneath -- a
 * trip is now a route through the lane graph driven by a real vehicle, or a
 * walk along the same lanes -- and that is deliberately all that changed.
 */

export const enum CitizenState {
  AtHome = 0,
  ToWork = 1,
  AtWork = 2,
  ToHome = 3,
  /** No route: the network does not join home to work. Waits and retries. */
  Stranded = 4,
}

export interface CityCitizen {
  id: number;
  /** Permanent identity. Departure times hang off this, not off the index. */
  seed: number;
  name: string;
  age: number;

  home: number;
  work: number;

  state: CitizenState;
  /** Whether this household has a car. The rest walk. */
  hasCar: boolean;

  /** Where they are when they are not inside a vehicle. */
  at: Vector3;

  /** The vehicle they are driving, or -1. */
  vehicle: number;
  /** The walk they are on, or null. */
  walk: { route: LaneRoute; travelled: number } | null;
  /**
   * The route this trip follows, kept while it lasts.
   *
   * Held on the citizen rather than only in the vehicle because the road may
   * be full at the moment they set off: the route is found once, and the car
   * joins it when there is room.
   */
  route: LaneRoute | null;

  /** Sim minute the current trip started, for the commute they report. */
  tripStartMinute: number;
  /** How long the last completed trip took [sim minutes]. */
  lastTripMinutes: number;
  /** Sim minute at which a stranded citizen tries again. */
  retryAtMinute: number;

  happiness: number;
  unhappyHours: number;
  /** Set when they have given up on the city; removed at the next migration. */
  left: boolean;
}

const FAMILY = [
  '佐藤', '鈴木', '高橋', '田中', '伊藤', '渡辺', '山本', '中村',
  '小林', '加藤', '吉田', '山田', '松本', '井上', '木村', '林',
];
const GIVEN = [
  '陽介', '美咲', '健太', '沙織', '大輔', '結衣', '直樹', '真央',
  '翔太', '彩香', '拓也', '奈々', '亮', '千尋', '悠斗', '葵',
];

/** The share of households with a car. The rest are why transit is worth it. */
export const CAR_OWNERSHIP = 0.8;

export function createCitizen(
  id: number,
  seed: number,
  home: number,
  at: Vector3,
  rng: Rng,
): CityCitizen {
  return {
    id,
    seed,
    name: `${rng.pick(FAMILY)} ${rng.pick(GIVEN)}`,
    age: 22 + rng.int(43),
    home,
    work: -1,
    state: CitizenState.AtHome,
    hasCar: rng.next() < CAR_OWNERSHIP,
    at: at.clone(),
    vehicle: -1,
    walk: null,
    route: null,
    tripStartMinute: 0,
    lastTripMinutes: 0,
    retryAtMinute: 0,
    happiness: -1,
    unhappyHours: 0,
    left: false,
  };
}

/** Walking pace [m/s]. Slow enough that a bus route is worth building. */
export const WALK_SPEED = 1.35;

const SALT_MORNING = 0x9e37;
const SALT_EVENING = 0x85eb;

/** Spread either side of the nominal hour [sim minutes]. */
const JITTER = 55;

/**
 * When this citizen leaves for work, and for home.
 *
 * Derived from the seed rather than stored, so that somebody's routine does
 * not shift because a neighbour moved out and the arrays were compacted --
 * the same reason the tile city derived them.
 */
export function departForWorkMinute(seed: number): number {
  return wrap(8 * 60 + (hashToUnit(seed, SALT_MORNING) * 2 - 1) * JITTER);
}

export function departForHomeMinute(seed: number): number {
  return wrap(17 * 60 + (hashToUnit(seed, SALT_EVENING) * 2 - 1) * JITTER);
}

/** True when `now` is inside the window that opens at `from`. */
export function inDepartureWindow(now: number, from: number, windowMinutes: number): boolean {
  return (now - from + 1440) % 1440 < windowMinutes;
}

function wrap(minute: number): number {
  const m = Math.round(minute) % 1440;
  return m < 0 ? m + 1440 : m;
}

/** Where a citizen is drawn: inside their vehicle, or on their own two feet. */
export function positionOf(citizen: CityCitizen, vehicles: readonly Vehicle[]): Vector3 {
  if (citizen.vehicle >= 0) {
    const vehicle = vehicles.find((v) => v.id === citizen.vehicle);
    if (vehicle?.bodies[0]) return vehicle.bodies[0].pos;
  }
  return citizen.at;
}
