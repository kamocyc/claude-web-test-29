import { MAP_SIZE } from '../config';
import { hashToUnit, type Rng } from '../core/rng';
import {
  CitizenState,
  TravelMode,
  type BuildingId,
  type CitizenId,
  type TileIndex,
} from '../core/types';

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
  /** Tick the current trip began, for the inspector's travel-time readout. */
  tripStartTick: number;
  /** Set when a path request is queued, so it is not requested twice. */
  awaitingPath: boolean;
  /** Retry countdown after a failed route, so stranded citizens do not spin. */
  retryAtTick: number;
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
    tripStartTick: 0,
    awaitingPath: false,
    retryAtTick: 0,
  };
}

/** Stable per-citizen offset in [-1, 1], used to spread the rush hour. */
export function scheduleJitter(id: CitizenId, salt: number): number {
  return hashToUnit(id, salt) * 2 - 1;
}

export function isTravelling(c: Citizen): boolean {
  return c.state === CitizenState.ToWork || c.state === CitizenState.ToHome;
}


export function tileCenterX(i: TileIndex): number {
  return (i % MAP_SIZE) + 0.5;
}

export function tileCenterY(i: TileIndex): number {
  return ((i / MAP_SIZE) | 0) + 0.5;
}
