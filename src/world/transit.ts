import {
  BUSES_PER_LINE,
  BUS_CAPACITY,
  BUS_DWELL_TICKS,
  BUS_FREE_SPEED,
  BUS_STOP_WALK_RADIUS,
  STATION_WALK_RADIUS,
  TRAINS_PER_LINE,
  TRAIN_CAPACITY,
  TRAIN_DWELL_TICKS,
  TRAIN_FREE_SPEED,
} from '../config';
import { BuildingType } from '../core/types';
import type { BuildingId, CitizenId, LineId, TileIndex, TrainId } from '../core/types';

/**
 * What a line runs on.
 *
 * The two modes share everything above the rails: the same ordered list of
 * stops, the same stored round trip, the same boarding, the same planner. They
 * differ in one table (`MODES` below) and in which network their route is laid
 * over -- which is exactly the difference between a bus and a train, and no
 * more. Writing buses as a second, parallel transit system would have meant
 * two boarding models, two planners, and two sets of bugs.
 */
export const enum LineMode {
  Rail = 0,
  Road = 1,
}

/** Everything that differs between a railway and a bus route, in one table. */
export interface LineSpec {
  freeSpeed: number;
  dwellTicks: number;
  capacity: number;
  /** Vehicles put on a new line. More of them is a shorter wait. */
  vehicles: number;
  /** How far somebody will walk to reach a stop of this kind. */
  walkRadius: number;
  /** The building a stop of this kind is. */
  stopType: BuildingType;
  label: string;
}

const MODES: Record<LineMode, LineSpec> = {
  [LineMode.Rail]: {
    freeSpeed: TRAIN_FREE_SPEED,
    dwellTicks: TRAIN_DWELL_TICKS,
    capacity: TRAIN_CAPACITY,
    vehicles: TRAINS_PER_LINE,
    walkRadius: STATION_WALK_RADIUS,
    stopType: BuildingType.Station,
    label: '鉄道',
  },
  [LineMode.Road]: {
    freeSpeed: BUS_FREE_SPEED,
    dwellTicks: BUS_DWELL_TICKS,
    capacity: BUS_CAPACITY,
    vehicles: BUSES_PER_LINE,
    walkRadius: BUS_STOP_WALK_RADIUS,
    stopType: BuildingType.BusStop,
    label: 'バス',
  },
};

export function specForMode(mode: LineMode): LineSpec {
  return MODES[mode];
}

export function lineSpec(line: TransitLine): LineSpec {
  return MODES[line.mode];
}

/** The mode a stop building belongs to, or null if it is not a stop at all. */
export function modeForStop(type: BuildingType): LineMode | null {
  if (type === BuildingType.Station) return LineMode.Rail;
  if (type === BuildingType.BusStop) return LineMode.Road;
  return null;
}

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
  /** Whether this line runs on rails or on the roads. */
  mode: LineMode;
  /** Stops in the order the player picked them, one way. */
  stations: BuildingId[];
  /** Route tiles -- rail or road, by mode -- for one full round trip. */
  route: TileIndex[];
  /** Index into `route` of each stop, in the order a vehicle reaches them. */
  stopAt: number[];
  /** Stop id for each entry in `stopAt`. */
  stopStation: BuildingId[];
  /**
   * The vehicles working the line: indices into `world.trains` for a railway,
   * into `world.buses` for a bus route. Which array they index is the line's
   * mode, so a rider never has to carry that knowledge around with them.
   */
  vehicles: number[];
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

/** True while there is still room aboard for one more rider. */
export function hasRoom(line: TransitLine, passengers: number): boolean {
  return passengers < MODES[line.mode].capacity;
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
  const spec = MODES[line.mode];
  // Every stop in between costs its dwell. On a railway with four stops that
  // is a rounding error; on a bus route calling every few blocks it is most
  // of the difference between the two modes, and leaving it out would have
  // the planner quoting bus times it can never keep.
  const stops = stopsBetween(line, fromStop, toStop);
  return distance / spec.freeSpeed + stops * spec.dwellTicks;
}

/** How many intermediate stops a rider sits through, going forward round the line. */
function stopsBetween(line: TransitLine, fromStop: number, toStop: number): number {
  const n = line.stopAt.length;
  let count = 0;
  for (let i = 1; i < n; i++) {
    if ((fromStop + i) % n === toStop) break;
    count++;
  }
  return count;
}

/** A full circuit of the line, including the time spent standing at platforms. */
export function lapTicks(line: TransitLine): number {
  const spec = MODES[line.mode];
  const running = (line.route.length - 1) / spec.freeSpeed;
  // Dwell is not a rounding error: six stops at 20 ticks is a quarter of the
  // circuit on a short line, and leaving it out makes every predicted wait
  // optimistic -- which shows up directly as the inspector under-quoting.
  return running + line.stopAt.length * spec.dwellTicks;
}

/** Mean wait: half a headway, with the trains spread evenly over the route. */
export function expectedWaitTicks(line: TransitLine): number {
  const vehicles = Math.max(1, line.vehicles.length);
  return lapTicks(line) / vehicles / 2;
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
