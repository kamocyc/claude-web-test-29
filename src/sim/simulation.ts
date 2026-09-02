import {
  CAR_FREE_SPEED,
  GROWTH_INTERVAL_MINUTES,
  PATH_REQUESTS_PER_TICK,
  WALK_DISTANCE_THRESHOLD,
  WALK_SPEED,
} from '../config';
import { Clock, minutesToTicks } from '../core/clock';
import { manhattan } from '../core/grid';
import { CitizenState, TravelMode, type BuildingId } from '../core/types';
import { growCity } from '../world/zoning';
import type { World } from '../world/world';
import { tileCenterX, tileCenterY, type Citizen } from './citizen';
import { advanceCitizen, pathIsBroken, registerOccupancy, setPositionFromPath } from './movement';
import { Crossings } from './crossings';
import { Occupancy } from './occupancy';
import { Signals } from './signals';
import { Statistics } from './statistics';
import { departForHomeMinute, departForWorkMinute, inDepartureWindow } from './schedule';
import { findPath, PathCache } from './pathfinding';
import { advanceTrain, carryPassengers } from './trains';
import { planTransit, transitWins } from './transitPlanner';
import { TrafficMemory } from './trafficMemory';

/** How long after their departure minute a citizen still counts as leaving. */
const DEPARTURE_WINDOW_MINUTES = 30;
/** Ticks a stranded citizen waits before trying to route again. */
const STRANDED_RETRY_TICKS = 200;

export class Simulation {
  readonly clock = new Clock();
  readonly occupancy = new Occupancy();
  readonly crossings = new Crossings();
  readonly signals = new Signals();
  readonly stats = new Statistics();
  readonly traffic = new TrafficMemory();
  readonly pathCache = new PathCache();

  strandedCount = 0;

  private pathQueue: Citizen[] = [];

  /**
   * The growth bucket already evaluated. Public because a save has to carry
   * it: starting a loaded city back at -1 would run an extra growth step the
   * moment it resumed, so every save/load cycle would quietly inflate the
   * town.
   */
  lastGrowthBucket = -1;

  constructor(readonly world: World) {}

  tick(): void {
    this.clock.step();
    this.updateSchedules();
    this.servePathRequests();
    this.moveTrains();
    this.crossings.update(this.world);
    this.signals.refresh(this.world);
    this.rescueOrphanedRiders();
    this.moveCitizens();
    this.maybeGrow();
    // Last, so the census always includes anyone who moved in this tick.
    this.stats.sample(this.world);
  }

  // --- Schedule ------------------------------------------------------------

  private updateSchedules(): void {
    const minute = this.clock.minuteOfDay;

    for (const c of this.world.citizens) {
      if (c.work < 0) continue;

      switch (c.state) {
        case CitizenState.AtHome:
          if (inDepartureWindow(minute, departForWorkMinute(c.id), DEPARTURE_WINDOW_MINUTES)) {
            this.beginTrip(c, CitizenState.ToWork, c.work);
          }
          break;
        case CitizenState.AtWork:
          if (inDepartureWindow(minute, departForHomeMinute(c.id), DEPARTURE_WINDOW_MINUTES)) {
            this.beginTrip(c, CitizenState.ToHome, c.home);
          }
          break;
        case CitizenState.Stranded:
          if (this.clock.tick >= c.retryAtTick) {
            const target = c.destination;
            const wantsWork = target === c.work;
            this.beginTrip(c, wantsWork ? CitizenState.ToWork : CitizenState.ToHome, target);
          }
          break;
        default:
          break;
      }
    }
  }

  private beginTrip(c: Citizen, state: CitizenState, destination: BuildingId): void {
    c.state = state;
    c.destination = destination;
    c.path = null;
    c.s = 0;
    c.v = 0;
    c.blockedTicks = 0;
    c.signalHold = -1;
    c.ride = null;
    c.legAfterRide = null;
    c.boardedTrain = -1;
    c.lastWaitTicks = 0;
    c.tripStartTick = this.clock.tick;
    this.requestRoute(c);
  }

  /** Queue a routing request, unless one is already outstanding. */
  requestRoute(c: Citizen): void {
    if (c.awaitingPath) return;
    c.awaitingPath = true;
    this.pathQueue.push(c);
  }

  // --- Routing -------------------------------------------------------------

  /**
   * Routing is rate-limited because the morning departure spike would
   * otherwise run hundreds of A* searches inside a single tick and drop a
   * frame. Anyone not served this tick simply leaves a moment later.
   */
  private servePathRequests(): void {
    let served = 0;
    while (this.pathQueue.length > 0 && served < PATH_REQUESTS_PER_TICK) {
      const c = this.pathQueue.shift()!;
      c.awaitingPath = false;
      served++;
      if (c.state === CitizenState.ToWork || c.state === CitizenState.ToHome) {
        this.route(c);
      }
    }
  }

  private route(c: Citizen): void {
    const { world } = this;
    const from = world.buildings[c.state === CitizenState.ToWork ? c.home : c.work];
    const to = world.buildings[c.destination];

    if (!from || !to || !world.isAlive(from) || !world.isAlive(to)) {
      this.strand(c);
      return;
    }

    world.refreshAccess(from);
    world.refreshAccess(to);
    if (from.accessRoad < 0 || to.accessRoad < 0) {
      this.strand(c);
      return;
    }

    const key = `${from.accessRoad}:${to.accessRoad}`;
    const roadPath = this.pathCache.get(world.roads, key, () =>
      findPath(world.roads, from.accessRoad, to.accessRoad),
    );

    const doorToDoor = roadPath ? [from.tile, ...roadPath, to.tile] : null;
    const surfaceMode = manhattan(from.tile, to.tile) > WALK_DISTANCE_THRESHOLD
      ? TravelMode.Car
      : TravelMode.Walk;

    // Compare the train against driving at free flow. Both estimates ignore
    // congestion, which keeps the comparison fair and means a citizen can
    // still choose the road and then get stuck in the jam the player built --
    // exactly the situation worth watching.
    if (world.activeLines.length > 0) {
      const plan = planTransit(world, from, to);
      const carTicks = doorToDoor ? this.traffic.driveTicks(doorToDoor) : Infinity;

      if (plan && transitWins(plan.totalTicks, carTicks)) {
        c.mode = TravelMode.Transit;
        c.ride = plan.ride;
        c.legAfterRide = plan.fromStation;
        c.path = plan.toStation;
        c.s = 0;
        c.v = 0;
        setPositionFromPath(c);
        return;
      }
    }

    if (!doorToDoor) {
      this.strand(c);
      return;
    }

    c.mode = surfaceMode;
    c.ride = null;
    c.legAfterRide = null;
    c.path = doorToDoor;
    c.s = 0;
    c.v = 0;
    setPositionFromPath(c);
  }

  private strand(c: Citizen): void {
    c.state = CitizenState.Stranded;
    c.path = null;
    c.v = 0;
    c.ride = null;
    c.legAfterRide = null;
    c.boardedTrain = -1;
    c.retryAtTick = this.clock.tick + STRANDED_RETRY_TICKS;
    const home = this.world.buildings[c.home];
    if (home) {
      c.x = tileCenterX(home.tile);
      c.y = tileCenterY(home.tile);
      c.prevX = c.x;
      c.prevY = c.y;
    }
  }

  // --- Movement ------------------------------------------------------------

  private moveCitizens(): void {
    registerOccupancy(this.world, this.occupancy);

    let stranded = 0;
    for (const c of this.world.citizens) {
      if (c.state === CitizenState.Stranded) {
        stranded++;
        continue;
      }
      if (c.state !== CitizenState.ToWork && c.state !== CitizenState.ToHome) continue;
      if (!c.path) {
        // Travelling with no route: the request is still in the queue, or the
        // city was just loaded from a save and the queue went with the old
        // one. Asking again is idempotent and costs a tick at most.
        this.requestRoute(c);
        continue;
      }

      if (pathIsBroken(this.world, c)) {
        this.beginTrip(c, c.state, c.destination);
        continue;
      }

      if (
        advanceCitizen(
          this.world,
          c,
          this.occupancy,
          this.crossings,
          this.signals,
          this.clock.tick,
        )
      ) {
        this.finishLeg(c);
      }
    }
    this.strandedCount = stranded;
    this.traffic.update(this.world, this.occupancy);
  }

  /**
   * A leg ended. If a ride is still pending the citizen has just reached a
   * platform and starts waiting; otherwise they are home or at their desk.
   */
  private finishLeg(c: Citizen): void {
    c.path = null;
    c.v = 0;
    if (c.ride && c.boardedTrain < 0) {
      c.state = CitizenState.Waiting;
      c.waitStartTick = this.clock.tick;
      return;
    }
    c.state = c.state === CitizenState.ToWork ? CitizenState.AtWork : CitizenState.AtHome;
    this.stats.recordTrip(c, this.clock.tick);
  }

  private moveTrains(): void {
    for (const train of this.world.trains) {
      advanceTrain(this.world, train, this.clock.tick);
      carryPassengers(this.world, train);
    }
  }

  /**
   * Someone whose line was demolished while they waited or rode. They are put
   * back on the pavement and re-plan from where they stand.
   */
  private rescueOrphanedRiders(): void {
    for (const c of this.world.citizens) {
      if (c.state !== CitizenState.Waiting && c.state !== CitizenState.Riding) continue;
      const line = c.ride ? this.world.lines[c.ride.line] : undefined;
      if (line && this.world.lineIsAlive(line)) continue;
      this.beginTrip(
        c,
        c.destination === c.work ? CitizenState.ToWork : CitizenState.ToHome,
        c.destination,
      );
    }
  }

  // --- Growth --------------------------------------------------------------

  private maybeGrow(): void {
    const bucket = Math.floor(this.clock.minuteOfDay / GROWTH_INTERVAL_MINUTES);
    if (bucket === this.lastGrowthBucket) return;
    this.lastGrowthBucket = bucket;
    growCity(this.world);
  }

  /**
   * Remaining travel time in ticks, from the same numbers the sim runs on --
   * so the ETA shown in the inspector is the sim's own estimate, not a
   * separate guess that could disagree with what the player watches happen.
   */
  estimateRemainingTicks(c: Citizen): number | null {
    if (!c.path) return null;
    const remaining = c.path.length - 1 - c.s;
    const speed = Math.max(c.v, speedFloor(c));
    return remaining / speed;
  }

  estimateArrivalMinute(c: Citizen): number | null {
    const ticks = this.estimateRemainingTicks(c);
    if (ticks === null) return null;
    const minutes = this.clock.minuteOfDay + ticks / minutesToTicks(1);
    return Math.round(minutes) % 1440;
  }
}


/** Assume the citizen gets back up to free-flow if currently stopped. */
function speedFloor(c: Citizen): number {
  return c.mode === TravelMode.Car ? CAR_FREE_SPEED * 0.6 : WALK_SPEED;
}
