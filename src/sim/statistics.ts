import { TRIP_HISTORY_SIZE } from '../config';
import { ticksToMinutes } from '../core/clock';
import { CitizenState, isEnRoute, TravelMode, type BuildingId } from '../core/types';
import type { World } from '../world/world';
import type { Citizen } from './citizen';

/** A snapshot of what the population is doing right now. */
export interface LiveStats {
  population: number;
  employed: number;
  atHome: number;
  atWork: number;
  travelling: number;
  waiting: number;
  riding: number;
  /** In a shop, filling a basket. */
  shopping: number;
  stranded: number;
  /** Travelling citizens by the mode they chose, riders included. */
  walking: number;
  driving: number;
  usingTransit: number;
}

/** Rolling averages over the trips that have actually finished. */
export interface TripStats {
  completed: number;
  /** Mean door-to-door time of the last TRIP_HISTORY_SIZE trips, in minutes. */
  meanMinutes: number;
  /** Mean of the same window, split by mode. */
  meanByMode: Record<TravelMode, number>;
  countByMode: Record<TravelMode, number>;
  /** Mean platform wait of the transit trips in the window, in minutes. */
  meanWaitMinutes: number;
}

interface TripRecord {
  mode: TravelMode;
  ticks: number;
  waitTicks: number;
}

const EMPTY_LIVE: LiveStats = {
  population: 0,
  employed: 0,
  atHome: 0,
  atWork: 0,
  travelling: 0,
  waiting: 0,
  riding: 0,
  shopping: 0,
  stranded: 0,
  walking: 0,
  driving: 0,
  usingTransit: 0,
};

/**
 * Everything the stats panel shows, gathered in the one pass over the
 * population the simulation already has to make.
 *
 * Two kinds of number live here and they are deliberately kept apart. The
 * live counts are a census: recomputed from scratch every tick, so they can
 * never drift from what is on screen. The trip averages are a *history*:
 * a trip only contributes once it finishes, over a bounded window, so the
 * panel reports what commuting actually cost rather than what the planner
 * hoped it would.
 */
export class Statistics {
  live: LiveStats = { ...EMPTY_LIVE };

  /** How many citizens are standing on each station's platform. */
  readonly waitingByStation = new Map<BuildingId, number>();

  /** Completed trips ever, for the "since day 1" counter. */
  totalCompleted = 0;

  private history: TripRecord[] = [];
  private cursor = 0;

  /** Recount the population. One pass, called once per tick. */
  sample(world: World): void {
    const s = { ...EMPTY_LIVE };
    this.waitingByStation.clear();

    for (const c of world.citizens) {
      s.population++;
      if (c.work >= 0) s.employed++;

      switch (c.state) {
        case CitizenState.AtHome:
          s.atHome++;
          break;
        case CitizenState.AtWork:
          s.atWork++;
          break;
        case CitizenState.Stranded:
          s.stranded++;
          break;
        case CitizenState.Waiting:
          s.waiting++;
          if (c.ride) {
            const at = c.ride.boardStation;
            this.waitingByStation.set(at, (this.waitingByStation.get(at) ?? 0) + 1);
          }
          break;
        case CitizenState.Riding:
          s.riding++;
          break;
        case CitizenState.AtShop:
          s.shopping++;
          break;
        default:
          s.travelling++;
          break;
      }

      if (isEnRoute(c.state)) {
        if (c.mode === TravelMode.Car) s.driving++;
        else if (c.mode === TravelMode.Transit) s.usingTransit++;
        else s.walking++;
      }
    }

    this.live = s;
  }

  waitingAt(station: BuildingId): number {
    return this.waitingByStation.get(station) ?? 0;
  }

  /** Record a finished door-to-door trip. */
  recordTrip(c: Citizen, tick: number): void {
    const ticks = tick - c.tripStartTick;
    if (ticks <= 0) return;
    this.totalCompleted++;
    const record: TripRecord = { mode: c.mode, ticks, waitTicks: c.lastWaitTicks };
    if (this.history.length < TRIP_HISTORY_SIZE) {
      this.history.push(record);
    } else {
      this.history[this.cursor] = record;
      this.cursor = (this.cursor + 1) % TRIP_HISTORY_SIZE;
    }
  }

  trips(): TripStats {
    const countByMode = { [TravelMode.Walk]: 0, [TravelMode.Car]: 0, [TravelMode.Transit]: 0 };
    const sumByMode = { [TravelMode.Walk]: 0, [TravelMode.Car]: 0, [TravelMode.Transit]: 0 };
    let sum = 0;
    let waitSum = 0;
    let waitCount = 0;

    for (const t of this.history) {
      sum += t.ticks;
      countByMode[t.mode]++;
      sumByMode[t.mode] += t.ticks;
      if (t.mode === TravelMode.Transit) {
        waitSum += t.waitTicks;
        waitCount++;
      }
    }

    const mean = (total: number, n: number): number =>
      n === 0 ? 0 : ticksToMinutes(total / n);

    return {
      completed: this.totalCompleted,
      meanMinutes: mean(sum, this.history.length),
      meanByMode: {
        [TravelMode.Walk]: mean(sumByMode[TravelMode.Walk], countByMode[TravelMode.Walk]),
        [TravelMode.Car]: mean(sumByMode[TravelMode.Car], countByMode[TravelMode.Car]),
        [TravelMode.Transit]: mean(sumByMode[TravelMode.Transit], countByMode[TravelMode.Transit]),
      },
      countByMode,
      meanWaitMinutes: mean(waitSum, waitCount),
    };
  }

  /** Restored from a save file; the window itself is not persisted. */
  restore(totalCompleted: number): void {
    this.totalCompleted = totalCompleted;
    this.history = [];
    this.cursor = 0;
  }
}
