import { MAP_SIZE, STARTING_PANTRY } from '../config';
import { hashToUnit, type Rng } from '../core/rng';
import {
  CitizenState,
  TravelMode,
  type BuildingId,
  type CitizenId,
  type TileIndex,
  type TrainId,
} from '../core/types';
import { CAR_PROFILE, type FollowingProfile } from './carFollowing';
import type { RideLeg } from './transitPlanner';

export interface Citizen {
  id: CitizenId;
  /**
   * A stable identity, unlike `id`.
   *
   * Ids are array indices, and the array is compacted whenever someone leaves
   * the city -- so anything that must not change under a neighbour's departure
   * hangs off this instead. Departure times are the reason: derived from the
   * id, a citizen's whole routine would shift the day somebody else moved out.
   */
  seed: number;
  name: string;
  age: number;

  home: BuildingId;
  work: BuildingId;

  state: CitizenState;
  mode: TravelMode;
  /**
   * How this citizen behaves when driving. Always the car profile -- walking
   * is handled by the mode, not by a second profile -- but it is a field
   * rather than a constant because that is what makes a citizen a `RoadAgent`
   * and lets lorries share the same movement code.
   */
  profile: FollowingProfile;

  /**
   * Full door-to-door route: [homeTile, accessRoad, ...roads, accessRoad, workTile].
   * Segments that touch a building tile are walked; road-to-road segments are
   * driven when `mode` is Car.
   */
  path: TileIndex[] | null;
  /** Where this trip started. */
  origin: BuildingId;
  destination: BuildingId;
  /**
   * Which journey this is, for as long as it lasts.
   *
   * `state` becomes Waiting or Riding while a train is involved, so it cannot
   * answer "where was this person going?" -- and the old answer, comparing the
   * destination against home and work, stopped being a complete question the
   * moment shops became a third place to go.
   */
  legState: CitizenState;

  /** Distance travelled along `path`, in tiles. Integer part = segment index. */
  s: number;
  /** Current speed in tiles/tick. Carried across ticks so acceleration exists. */
  v: number;

  x: number;
  y: number;
  prevX: number;
  prevY: number;

  /** Ticks spent unable to move; releases the soft tile capacity on gridlock. */
  blockedTicks: number;
  /**
   * The junction this car has decided to stop at, or -1.
   *
   * The decision has to be latched rather than recomputed. A car easing up to
   * a stop line approaches it asymptotically, and "could I still brake from
   * here?" eventually answers no for any car that is close enough and moving
   * at all -- which would turn a car that has been waiting politely into one
   * that rolls through the red. Deciding once, when the light changes, and
   * holding that decision until it goes green is both stabler and closer to
   * what a driver actually does.
   */
  signalHold: TileIndex;
  /** Tick the current trip began, for the inspector's travel-time readout. */
  tripStartTick: number;
  /** Set when a path request is queued, so it is not requested twice. */
  awaitingPath: boolean;
  /** Retry countdown after a failed route, so stranded citizens do not spin. */
  retryAtTick: number;

  // --- Transit -------------------------------------------------------------
  // A transit trip is three legs: walk to the platform, ride, walk to the door.
  // `path` always holds the leg being walked or driven right now, so the whole
  // movement system stays unaware that trains exist; these fields hold the
  // rest of the itinerary until it is that leg's turn.

  /** The ride this citizen is waiting for or taking. Null when not on transit. */
  ride: RideLeg | null;
  /** Walking path from the alighting station to the door, held during the ride. */
  legAfterRide: TileIndex[] | null;
  /** Train currently aboard, or -1. */
  boardedTrain: TrainId;
  /** Tick the citizen reached the platform, for the "waited N min" readout. */
  waitStartTick: number;
  /** How long the last boarding actually took, kept for the trip statistics. */
  lastWaitTicks: number;

  // --- Wellbeing -----------------------------------------------------------

  /** 0..100, or -1 before the first evaluation. Smoothed, not instantaneous. */
  happiness: number;
  /** Consecutive sim-hours spent below the threshold. Patience before leaving. */
  unhappyHours: number;
  /** Duration of the last completed trip, which is what the commute is judged on. */
  lastTripTicks: number;
  /**
   * Days of groceries in the cupboard. Drains steadily and is refilled by
   * going to a shop, which is what turns "the city has goods" into "this
   * person could actually buy some".
   */
  pantry: number;
  /** True when the last shopping trip found the shelves bare. */
  lastShopFailed: boolean;
  /** Set when the citizen has left the city; the hourly pass then removes them. */
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

export function createCitizen(
  id: CitizenId,
  home: BuildingId,
  work: BuildingId,
  homeTile: TileIndex,
  rng: Rng,
  seed = id,
): Citizen {
  return {
    id,
    seed,
    name: `${rng.pick(FAMILY)} ${rng.pick(GIVEN)}`,
    age: 22 + rng.int(43),
    home,
    work,
    state: CitizenState.AtHome,
    mode: TravelMode.Walk,
    profile: CAR_PROFILE,
    path: null,
    origin: home,
    destination: home,
    legState: CitizenState.AtHome,
    s: 0,
    v: 0,
    x: tileCenterX(homeTile),
    y: tileCenterY(homeTile),
    prevX: tileCenterX(homeTile),
    prevY: tileCenterY(homeTile),
    blockedTicks: 0,
    signalHold: -1,
    tripStartTick: 0,
    awaitingPath: false,
    retryAtTick: 0,
    ride: null,
    legAfterRide: null,
    boardedTrain: -1,
    waitStartTick: 0,
    lastWaitTicks: 0,
    happiness: -1,
    unhappyHours: 0,
    lastTripTicks: 0,
    pantry: STARTING_PANTRY,
    lastShopFailed: false,
    left: false,
  };
}

/** Stable per-citizen offset in [-1, 1], used to spread the rush hour. */
export function scheduleJitter(seed: number, salt: number): number {
  return hashToUnit(seed, salt) * 2 - 1;
}

export function isTravelling(c: Citizen): boolean {
  return c.state === CitizenState.ToWork || c.state === CitizenState.ToHome;
}

/** True while the citizen is moving under their own steam along `path`. */
export function isSelfPropelled(c: Citizen): boolean {
  return isTravelling(c) && c.path !== null;
}


export function tileCenterX(i: TileIndex): number {
  return (i % MAP_SIZE) + 0.5;
}

export function tileCenterY(i: TileIndex): number {
  return ((i / MAP_SIZE) | 0) + 0.5;
}
