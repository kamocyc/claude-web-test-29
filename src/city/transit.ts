import { Vector3 } from 'three';
import type { LineId } from '../track/network/line';
import type { Station, StationId } from '../track/network/station';
import type { LinePlan } from '../track/sim/lineRoute';
import type { Vehicle } from '../track/sim/traffic';
import type { CityBuilding } from './buildings';
import { simMinutes } from './clock';
import { doorstep } from './buildings';
import { findLaneRoute, laneStopsNear, nearestOn, type LaneRoute } from './routing';
import type { CityWorld } from './world';

/**
 * Riding the lines.
 *
 * The tile city moved people between stops by fiat: a rider vanished at one
 * stop and appeared at the next when the timetable said so. Here the trains
 * are real -- the traffic model is driving them along the lane graph, and they
 * stop at the platforms because the platform is on the lane -- so a rider can
 * be, too. A journey is: walk to the station, wait on the platform for a train
 * of the right line, ride it while it drives, and get off when it opens its
 * doors at the station you wanted.
 *
 * That is worth the trouble rather than being pedantry. It means a line is
 * only as good as the trains actually running on it: a route that is drawn on
 * the map but whose trains are stuck behind a signal strands its riders, and
 * the player can see why by watching the train.
 */

/**
 * How far somebody will walk to reach a station [m].
 *
 * Generous, because it is a *rail* catchment: ten minutes on foot is a price
 * people pay for a train in a way they would not for a bus stop. It is not the
 * same thing as how close the walk has to end up (`FORECOURT_RADIUS`) -- the
 * two were one number at first, and that made a station either unreachable or
 * reachable from half a mile of open field.
 */
export const STATION_WALK_RADIUS = 700;
/** How near the station a walk has to end to count as arriving at it [m]. */
export const FORECOURT_RADIUS = 90;
/** How long a rider waits on a platform before giving up [sim minutes]. */
export const MAX_WAIT_MINUTES = 90;
/** Riders a carriage holds. A full train leaves people behind. */
export const CAPACITY_PER_CAR = 90;
/** Assumed average speed of a line, for choosing between transit and a car. */
const LINE_SPEED = 14;
/** Assumed wait [sim minutes], for the same choice. Half a headway, roughly. */
const ASSUMED_WAIT_MINUTES = 6;
/** Walking pace [m/s of world time], for the estimate only. */
const WALK_PACE = 1.35;

export const enum JourneyLeg {
  /** Walking from the door to the platform. */
  ToStation = 0,
  /** On the platform, watching for a train of the right line. */
  Waiting = 1,
  /** Aboard. */
  Riding = 2,
  /** Walking from the platform to the door. */
  FromStation = 3,
}

export interface Journey {
  line: LineId;
  board: StationId;
  alight: StationId;
  leg: JourneyLeg;
  /** The walk out of the alighting station, found when the journey is planned. */
  egress: LaneRoute | null;
  /** Sim minute the rider reached the platform, so a hopeless wait can end. */
  waitingSince: number;
  /** Estimated door-to-door time [sim minutes], for choosing this over a car. */
  minutes: number;
}

export interface PlannedJourney {
  journey: Journey;
  /** The walk to the boarding station. */
  access: LaneRoute;
}

/**
 * The best journey by transit between two buildings, or null.
 *
 * "Best" is the shortest estimate of walk + wait + ride over every pair of
 * stops on every line that runs. The estimate is deliberately crude -- a
 * straight line at a nominal speed -- because the honest number only exists
 * once the trip has been made, and a rider choosing a route does not have it.
 */
export function planJourney(
  world: CityWorld,
  from: CityBuilding,
  to: CityBuilding,
): PlannedJourney | null {
  const plans = world.result?.lines ?? [];
  if (plans.length === 0) return null;
  const stations = world.net.stations;

  const origin = doorstep(world, from) ?? from.at;
  const destination = doorstep(world, to) ?? to.at;

  let best: PlannedJourney | null = null;
  for (const plan of plans) {
    if (!plan.runnable) continue;
    const board = nearestStop(plan, stations, origin);
    const alight = nearestStop(plan, stations, destination);
    if (!board || !alight || board.station.id === alight.station.id) continue;
    if (board.distance > STATION_WALK_RADIUS || alight.distance > STATION_WALK_RADIUS) continue;

    // Distances over speeds give seconds of world time; the wait is already
    // in the city's minutes. Everything is converted before it is added, or
    // the wait would weigh sixty times what it should.
    const ride = simMinutes(
      board.station.center.distanceTo(alight.station.center) / LINE_SPEED,
    );
    const walk = simMinutes((board.distance + alight.distance) / WALK_PACE);
    const minutes = walk + ride + ASSUMED_WAIT_MINUTES;
    if (best && minutes >= best.journey.minutes) continue;

    // Only now is it worth paying for the two route searches.
    const access = walkTo(world, from, board.station);
    if (!access) continue;
    const egress = walkFrom(world, alight.station, to);
    if (!egress) continue;

    best = {
      access,
      journey: {
        line: plan.id,
        board: board.station.id,
        alight: alight.station.id,
        leg: JourneyLeg.ToStation,
        egress,
        waitingSince: 0,
        minutes,
      },
    };
  }
  return best;
}

/** The stop on this line closest to a point, with how far away it is. */
function nearestStop(
  plan: LinePlan,
  stations: ReadonlyMap<StationId, Station>,
  at: Vector3,
): { station: Station; distance: number } | null {
  let best: { station: Station; distance: number } | null = null;
  for (const stop of plan.stops) {
    const station = stations.get(stop.id);
    if (!station) continue;
    const distance = station.center.distanceTo(at);
    if (!best || distance < best.distance) best = { station, distance };
  }
  return best;
}

/** A walk from a building's door to a station's forecourt, along the streets. */
function walkTo(world: CityWorld, from: CityBuilding, station: Station): LaneRoute | null {
  if (!from.access) return null;
  const graph = world.laneGraph;
  const starts = laneStopsNear(graph, from.access.segment, doorstep(world, from) ?? from.at);
  const ends = roadLanesNear(world, station.center);
  if (starts.length === 0 || ends.length === 0) return null;
  return findLaneRoute(graph, { from: starts, to: ends, kind: 'car', limit: 2500 });
}

function walkFrom(world: CityWorld, station: Station, to: CityBuilding): LaneRoute | null {
  if (!to.access) return null;
  const graph = world.laneGraph;
  const starts = roadLanesNear(world, station.center);
  const ends = laneStopsNear(graph, to.access.segment, doorstep(world, to) ?? to.at);
  if (starts.length === 0 || ends.length === 0) return null;
  return findLaneRoute(graph, { from: starts, to: ends, kind: 'car', limit: 2500 });
}

/**
 * The road lanes a station can be reached from on foot.
 *
 * People walk along the streets here, not across the fields, which is why a
 * station with no road to it is a station nobody uses -- and why that is worth
 * showing rather than papering over.
 */
export function roadLanesNear(
  world: CityWorld,
  at: Vector3,
  radius = FORECOURT_RADIUS,
): Array<{ lane: number; s: number }> {
  const out: Array<{ lane: number; s: number }> = [];
  const limit = radius * radius;
  for (const lane of world.laneGraph.lanes) {
    if (lane.kind !== 'segment' || lane.vehicleKind !== 'car') continue;
    // A cheap rejection on the lane's midpoint before the nearest-point search.
    const mid = lane.path.poseAt(lane.path.length / 2).pos;
    const span = lane.path.length / 2 + radius;
    if ((mid.x - at.x) ** 2 + (mid.z - at.z) ** 2 > span * span) continue;
    const s = nearestOn(lane.path, at);
    const p = lane.path.poseAt(s).pos;
    if ((p.x - at.x) ** 2 + (p.z - at.z) ** 2 <= limit) out.push({ lane: lane.id, s });
  }
  return out;
}

/** True when this train is standing at `station` with its doors open. */
export function isBoardable(vehicle: Vehicle, line: LineId, station: StationId): boolean {
  return (
    vehicle.line?.id === line
    && vehicle.dwellUntil !== undefined
    && vehicle.lastStation === station
  );
}

/** How many riders a vehicle will take. */
export function capacityOf(vehicle: Vehicle): number {
  return Math.max(1, vehicle.cars) * CAPACITY_PER_CAR;
}
