import { TRAIN_CAPACITY, TRAIN_DWELL_TICKS, TRAIN_FREE_SPEED } from '../config';
import type { BuildingId, CitizenId, LineId, TileIndex, TrainId } from '../core/types';

/**
 * A train line: an ordered list of stations, plus the rail route that serves
 * them.
 *
 * `route` is the full **round trip** -- A,B,C,B,A -- rather than the one-way
 * path. Storing it that way means a train never needs a direction flag or a
 * reversal case: it advances along the route and wraps at the end, and the
 * out-and-back shape falls out of the data. A genuine loop line (last station
 * adjacent to the first) works through exactly the same code.
 */
export interface TransitLine {
  id: LineId;
  name: string;
  color: string;
  /** Stations in the order the player picked them, one way. */
  stations: BuildingId[];
  /** Rail tiles for one full round trip. */
  route: TileIndex[];
  /** Index into `route` of each stop, in the order a train reaches them. */
  stopAt: number[];
  /** Station id for each entry in `stopAt`. */
  stopStation: BuildingId[];
  trains: TrainId[];
  /** Riders delivered, for the HUD. */
  ridership: number;
}

export interface Train {
  id: TrainId;
  line: LineId;
  /** Distance along `line.route`, in tiles. Wraps at the end of the route. */
  s: number;
  v: number;
  /** Index into `line.stopAt` of the stop being approached. */
  nextStop: number;
  /** Tick the train may leave the platform. 0 when not dwelling. */
  dwellUntil: number;
  passengers: CitizenId[];
  x: number;
  y: number;
  prevX: number;
  prevY: number;
}

export function trainHasRoom(t: Train): boolean {
  return t.passengers.length < TRAIN_CAPACITY;
}

/**
 * Ticks to ride from one stop occurrence to another, following the route
 * forward and wrapping. Used both to pick a route and to show an ETA, so the
 * estimate and the ride cannot disagree about which way round the line goes.
 */
export function rideTicks(line: TransitLine, fromStop: number, toStop: number): number {
  const total = line.route.length - 1;
  const from = line.stopAt[fromStop];
  const to = line.stopAt[toStop];
  const distance = to >= from ? to - from : total - from + to;
  return distance / TRAIN_FREE_SPEED;
}

/** A full circuit of the line, including the time spent standing at platforms. */
export function lapTicks(line: TransitLine): number {
  const running = (line.route.length - 1) / TRAIN_FREE_SPEED;
  // Dwell is not a rounding error: six stops at 20 ticks is a quarter of the
  // circuit on a short line, and leaving it out makes every predicted wait
  // optimistic -- which shows up directly as the inspector under-quoting.
  return running + line.stopAt.length * TRAIN_DWELL_TICKS;
}

/** Mean wait: half a headway, with the trains spread evenly over the route. */
export function expectedWaitTicks(line: TransitLine): number {
  const trains = Math.max(1, line.trains.length);
  return lapTicks(line) / trains / 2;
}

/** Every stop occurrence that serves `station`, earliest first. */
export function stopsFor(line: TransitLine, station: BuildingId): number[] {
  const out: number[] = [];
  for (let i = 0; i < line.stopStation.length; i++) {
    if (line.stopStation[i] === station) out.push(i);
  }
  return out;
}

export const LINE_COLORS = [
  '#e05c5c',
  '#4ea3e0',
  '#6fce7a',
  '#d99ae0',
  '#e0b84e',
  '#5ce0cd',
] as const;
