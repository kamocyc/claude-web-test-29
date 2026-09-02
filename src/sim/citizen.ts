import { MAP_SIZE } from '../config';
import { hashToUnit, type Rng } from '../core/rng';
import {
  CitizenState,
  TravelMode,
  type BuildingId,
  type CitizenId,
  type TileIndex,
  type TrainId,
} from '../core/types';
import type { RideLeg } from './transitPlanner';

export interface Citizen {
  id: CitizenId;
  name: string;
  age: number;

  home: BuildingId;
  work: BuildingId;

  state: CitizenState;
  mode: TravelMode;

  /**
   * Full door-to-door route: [homeTile, accessRoad, ...roads, accessRoad, workTile].
   * Segments that touch a building tile are walked; road-to-road segments are
   * driven when `mode` is Car.
   */
  path: TileIndex[] | null;
  destination: BuildingId;

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
): Citizen {
  return {
    id,
    name: `${rng.pick(FAMILY)} ${rng.pick(GIVEN)}`,
    age: 22 + rng.int(43),
    home,
    work,
    state: CitizenState.AtHome,
    mode: TravelMode.Walk,
    path: null,
    destination: home,
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
  };
}

/** Stable per-citizen offset in [-1, 1], used to spread the rush hour. */
export function scheduleJitter(id: CitizenId, salt: number): number {
  return hashToUnit(id, salt) * 2 - 1;
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
