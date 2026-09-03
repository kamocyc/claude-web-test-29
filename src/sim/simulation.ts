import {
  CAR_FREE_SPEED,
  CHAIN_INTERVAL_MINUTES,
  EMERGENCY_INTERVAL_MINUTES,
  FIELD_INTERVAL_MINUTES,
  FREIGHT_INTERVAL_MINUTES,
  GROWTH_INTERVAL_MINUTES,
  MIGRATION_INTERVAL_MINUTES,
  PATH_REQUESTS_PER_TICK,
  POWER_INTERVAL_MINUTES,
  SHOPPING_DWELL_TICKS,
  SHOPPING_RETRY_TICKS,
  SHOPPING_TRIGGER,
  SHOPPING_WINDOW_MINUTES,
  SHOP_CLOSE_MINUTE,
  SERVICES_INTERVAL_MINUTES,
  SHOP_OPEN_MINUTE,
  WALK_DISTANCE_THRESHOLD,
  WALK_SPEED,
} from '../config';
import { Clock, minutesToTicks } from '../core/clock';
import { manhattan } from '../core/grid';
import {
  arrivalStateFor,
  CitizenState,
  isAtRest,
  isTravelling,
  TravelMode,
  type BuildingId,
  type TileIndex,
} from '../core/types';
import { growCity } from '../world/zoning';
import type { World } from '../world/world';
import { tileCenterX, tileCenterY, type Citizen } from './citizen';
import { advanceVehicle, pathIsBroken, registerVehicle, setPositionFromPath } from './movement';
import { Crossings } from './crossings';
import { Occupancy } from './occupancy';
import { Signals } from './signals';
import { Statistics } from './statistics';
import { Freight } from './freight';
import { Economy } from './economy';
import { PowerGrid } from './power';
import { SupplyChain } from './goods';
import { NoiseField } from './noise';
import { LandValueField } from './landValue';
import { Happiness } from './happiness';
import { Services } from './services';
import { CrimeField } from './crime';
import { Emergency } from './emergency';
import { forEachDrivingBus, stepBuses } from './buses';
import { educate } from './education';
import {
  departForHomeMinute,
  departForWorkMinute,
  inDepartureWindow,
  shoppingMinute,
} from './schedule';
import { buy, chooseShop } from './shopping';
import { findPath, PathCache } from './pathfinding';
import { carryPassengers } from './boarding';
import { advanceTrain } from './trains';
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
  readonly economy = new Economy();
  readonly power = new PowerGrid();
  readonly chain = new SupplyChain();
  readonly freight = new Freight();
  readonly noise = new NoiseField();
  readonly landValue = new LandValueField();
  readonly happiness = new Happiness();
  readonly services = new Services();
  readonly crime = new CrimeField();
  readonly emergency = new Emergency();

  strandedCount = 0;

  private pathQueue: Citizen[] = [];

  /**
   * The last bucket evaluated for each thing that runs on a slow cadence.
   * Public because a save has to carry them: starting a loaded city back at
   * -1 would run an extra growth step (and an extra day's tax) the moment it
   * resumed, so every save/load cycle would quietly inflate the town.
   */
  lastGrowthBucket = -1;
  lastPowerBucket = -1;
  lastChainBucket = -1;
  lastFieldBucket = -1;
  lastMigrationBucket = -1;
  lastFreightBucket = -1;
  lastServicesBucket = -1;
  lastEmergencyBucket = -1;
  lastSettledDay = -1;

  constructor(readonly world: World) {}

  tick(): void {
    this.clock.step();
    this.updateSchedules();
    this.servePathRequests();
    this.moveTrains();
    this.crossings.update(this.world);
    this.signals.refresh(this.world);
    this.rescueOrphanedRiders();
    this.freight.rescueOrphaned(this.world, this.clock.tick);
    this.moveCitizens();
    this.noise.sample(this.occupancy);
    this.runCity();
    // Last, so the census always includes anyone who moved in this tick.
    this.stats.sample(this.world);
  }

  // --- Schedule ------------------------------------------------------------

  private updateSchedules(): void {
    const minute = this.clock.minuteOfDay;

    for (const c of this.world.citizens) {
      // Somebody who has already given up their home -- burnt out with
      // nowhere to move to -- is not setting off for work. They are removed
      // at the next migration pass; until then they simply stay indoors,
      // rather than trying to travel from an address that no longer exists
      // and stranding themselves in the street.
      if (c.left) continue;

      switch (c.state) {
        case CitizenState.AtHome:
          if (c.work >= 0
            && inDepartureWindow(minute, departForWorkMinute(c.seed), DEPARTURE_WINDOW_MINUTES)) {
            this.beginTrip(c, CitizenState.ToWork, c.home, c.work);
            break;
          }
          this.maybeGoShopping(c, minute);
          break;
        case CitizenState.AtWork:
          if (inDepartureWindow(minute, departForHomeMinute(c.seed), DEPARTURE_WINDOW_MINUTES)) {
            this.beginTrip(c, CitizenState.ToHome, c.work, c.home);
          }
          break;
        case CitizenState.AtShop:
          if (this.clock.tick >= c.retryAtTick) {
            this.beginTrip(c, CitizenState.ToHome, c.destination, c.home);
          }
          break;
        case CitizenState.Stranded:
          if (this.clock.tick >= c.retryAtTick) {
            this.beginTrip(c, c.legState, c.origin, c.destination);
          }
          break;
        default:
          break;
      }
    }
  }

  /**
   * Head out for the groceries when the cupboard is low and the evening is
   * this citizen's shopping hour.
   *
   * Unlike the commute this applies to everybody, jobless included -- which is
   * also the first time the unemployed have had any reason to leave the house.
   */
  private maybeGoShopping(c: Citizen, minute: number): void {
    if (c.pantry > SHOPPING_TRIGGER) return;
    if (this.clock.tick < c.nextShopTick) return;

    const preferred = inDepartureWindow(minute, shoppingMinute(c.seed), SHOPPING_WINDOW_MINUTES);
    // An empty cupboard does not wait for tomorrow evening; it goes out
    // whenever the shops are open.
    const desperate = c.pantry <= 0
      && minute >= SHOP_OPEN_MINUTE && minute <= SHOP_CLOSE_MINUTE;
    if (!preferred && !desperate) return;

    const shop = chooseShop(this.world, c);
    if (shop < 0) return;
    this.beginTrip(c, CitizenState.ToShop, c.home, shop);
  }

  private beginTrip(
    c: Citizen,
    state: CitizenState,
    origin: BuildingId,
    destination: BuildingId,
  ): void {
    c.state = state;
    c.legState = state;
    c.origin = origin;
    c.destination = destination;
    c.path = null;
    c.s = 0;
    c.v = 0;
    c.blockedTicks = 0;
    c.signalHold = -1;
    c.ride = null;
    c.legAfterRide = null;
    c.boardedVehicle = -1;
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
      if (isTravelling(c.state)) this.route(c);
    }
  }

  private route(c: Citizen): void {
    const { world } = this;
    let from = world.buildings[c.origin];
    let to = world.buildings[c.destination];

    // The building a trip started from can be demolished while somebody is
    // inside it -- a shop that ran out of stock long enough to be abandoned is
    // the common case now that people go to shops. They are standing in the
    // street, so the trip restarts from home rather than stranding them
    // forever against an address that no longer exists.
    if (!from || !world.isAlive(from)) {
      c.origin = c.home;
      from = world.buildings[c.home];
    }
    // Somewhere that no longer exists is not worth travelling to; go home.
    if (!to || !world.isAlive(to)) {
      c.legState = CitizenState.ToHome;
      c.state = CitizenState.ToHome;
      c.destination = c.home;
      to = world.buildings[c.home];
    }
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
      findPath(world.roads, from.accessRoad, to.accessRoad, world.roadStep),
    );

    const doorToDoor = roadPath ? [from.tile, ...roadPath, to.tile] : null;
    // Somebody with no car walks, however far it is -- which is exactly the
    // person a bus route is for.
    const surfaceMode = c.hasCar && manhattan(from.tile, to.tile) > WALK_DISTANCE_THRESHOLD
      ? TravelMode.Car
      : TravelMode.Walk;

    // Compare transit against whatever this citizen would otherwise actually
    // do. Driving is priced at remembered congestion and walking at walking
    // pace: comparing a walker's options against a car they do not own was
    // what made every bus route in the city run empty.
    if (world.activeLines.length > 0) {
      const plan = planTransit(world, from, to);
      const surfaceTicks = surfaceTravelTicks(this.traffic, surfaceMode, doorToDoor);

      if (plan && transitWins(plan.totalTicks, surfaceTicks)) {
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
    c.boardedVehicle = -1;
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

  /**
   * Everything on the road, in two phases: publish where every vehicle is,
   * then move them all against that one snapshot. Cars and lorries share it,
   * so neither gets to go first.
   */
  private moveCitizens(): void {
    this.occupancy.clear();
    for (const c of this.world.citizens) {
      if (isAtRest(c.state)) continue;
      registerVehicle(this.world, this.occupancy, c);
    }
    this.freight.forEachDriving(this.world, (lorry) => {
      registerVehicle(this.world, this.occupancy, lorry);
    });
    // Buses and emergency vehicles are road users like any other: they are in
    // the same snapshot, so a car queues behind a bus at a stop and a fire
    // engine has to get through the jam rather than around it.
    forEachDrivingBus(this.world, (bus) => {
      registerVehicle(this.world, this.occupancy, bus);
    });
    this.emergency.forEachDriving(this.world, (unit) => {
      registerVehicle(this.world, this.occupancy, unit);
    });

    let stranded = 0;
    for (const c of this.world.citizens) {
      if (c.state === CitizenState.Stranded) {
        stranded++;
        continue;
      }
      if (!isTravelling(c.state)) continue;
      if (!c.path) {
        // Travelling with no route: the request is still in the queue, or the
        // city was just loaded from a save and the queue went with the old
        // one. Asking again is idempotent and costs a tick at most.
        this.requestRoute(c);
        continue;
      }

      if (pathIsBroken(this.world, c)) {
        this.beginTrip(c, c.legState, c.origin, c.destination);
        continue;
      }

      if (
        advanceVehicle(
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
    this.freight.step(
      this.world,
      this.occupancy,
      this.crossings,
      this.signals,
      this.clock.tick,
    );
    stepBuses(this.world, this.occupancy, this.crossings, this.signals, this.clock.tick);
    this.emergency.step(
      this.world,
      this.crime,
      this.occupancy,
      this.crossings,
      this.signals,
      this.clock.tick,
    );
    this.traffic.update(this.occupancy);
  }

  /**
   * A leg ended. If a ride is still pending the citizen has just reached a
   * platform and starts waiting; otherwise they are home or at their desk.
   */
  private finishLeg(c: Citizen): void {
    c.path = null;
    c.v = 0;
    if (c.ride && c.boardedVehicle < 0) {
      c.state = CitizenState.Waiting;
      c.waitStartTick = this.clock.tick;
      return;
    }
    c.state = arrivalStateFor(c.legState);
    c.lastTripTicks = Math.max(0, this.clock.tick - c.tripStartTick);
    this.stats.recordTrip(c, this.clock.tick);

    if (c.state === CitizenState.AtShop) {
      const shop = this.world.buildings[c.destination];
      if (shop && shop.alive) this.chain.recordSale(buy(shop, c));
      else c.lastShopFailed = true;
      // A short browse, then home -- whether or not the trip was worth it.
      c.retryAtTick = this.clock.tick + SHOPPING_DWELL_TICKS;
      // Nobody sets out again straight away, whether the trip worked or not.
      // A full basket lasts days and never notices this; a half-filled one
      // would otherwise turn back round at the door.
      c.nextShopTick = this.clock.tick + SHOPPING_RETRY_TICKS;
    }
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
      this.beginTrip(c, c.legState, c.origin, c.destination);
    }
  }

  // --- The city ------------------------------------------------------------

  /**
   * Everything that runs slower than a tick, in the order the city depends on
   * it.
   *
   * The order is the causal chain and is not arbitrary. Power decides which
   * buildings work at all; the supply chain then runs on the ones that do;
   * the noise and land value fields are a consequence of both; happiness
   * reads those fields; migration acts on happiness; and growth builds for
   * the population migration just produced. Running any of these on the
   * previous hour's answer would show up directly as the panels disagreeing
   * with the map.
   */
  private runCity(): void {
    const minute = this.clock.minuteOfDay;

    if (this.due('lastPowerBucket', minute, POWER_INTERVAL_MINUTES)) {
      this.power.update(this.world);
    }
    if (this.due('lastChainBucket', minute, CHAIN_INTERVAL_MINUTES)) {
      this.chain.step(this.world);
    }
    if (this.due('lastFreightBucket', minute, FREIGHT_INTERVAL_MINUTES)) {
      this.freight.dispatch(this.world, this.pathCache, this.traffic, this.clock.tick);
    }
    if (this.due('lastServicesBucket', minute, SERVICES_INTERVAL_MINUTES)) {
      this.services.update(this.world);
    }
    if (this.due('lastEmergencyBucket', minute, EMERGENCY_INTERVAL_MINUTES)) {
      this.emergency.spawn(this.world, this.crime, this.services, this.clock.tick);
      this.emergency.dispatch(this.world);
    }
    if (this.due('lastFieldBucket', minute, FIELD_INTERVAL_MINUTES)) {
      this.noise.update(this.world);
      // Crime is priced off yesterday's land value and then charged against
      // today's, which is the loop the player plays against: a cheap district
      // gets the crime, and the crime keeps it cheap until a police station
      // breaks the cycle.
      this.crime.update(this.world, this.landValue);
      this.landValue.update(this.world, this.noise, this.crime);
      educate(this.world, this.services);
      this.happiness.update(
        this.world,
        this.landValue,
        this.noise,
        this.crime,
        this.services,
        this.economy,
        this.clock.tick,
      );
    }
    if (this.due('lastMigrationBucket', minute, MIGRATION_INTERVAL_MINUTES)) {
      this.happiness.migrate(this.world);
    }
    if (this.due('lastGrowthBucket', minute, GROWTH_INTERVAL_MINUTES)) {
      growCity(this.world, (tile) => this.landValue.at(tile));
    }

    // The books close once a day, at midnight.
    if (this.clock.day !== this.lastSettledDay) {
      if (this.lastSettledDay >= 0) {
        this.economy.settleDay(this.world);
        this.freight.endDay();
        this.emergency.endDay();
      }
      this.lastSettledDay = this.clock.day;
    }
  }

  /** True once per bucket of `everyMinutes`, remembering the last one seen. */
  private due(
    field: 'lastPowerBucket' | 'lastChainBucket' | 'lastFieldBucket'
      | 'lastMigrationBucket' | 'lastGrowthBucket' | 'lastFreightBucket'
      | 'lastServicesBucket' | 'lastEmergencyBucket',
    minute: number,
    everyMinutes: number,
  ): boolean {
    const bucket = Math.floor(minute / everyMinutes);
    if (bucket === this[field]) return false;
    this[field] = bucket;
    return true;
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


/**
 * How long the trip takes without transit: the thing a ride has to beat.
 *
 * Driving is priced at remembered speeds so a jam really does push people onto
 * the buses; walking is priced at walking pace, which is what makes a stop
 * outside the front door worth having.
 */
function surfaceTravelTicks(
  traffic: TrafficMemory,
  mode: TravelMode,
  path: TileIndex[] | null,
): number {
  if (!path) return Infinity;
  if (mode === TravelMode.Car) return traffic.driveTicks(path);
  return (path.length - 1) / WALK_SPEED;
}

/** Assume the citizen gets back up to free-flow if currently stopped. */
function speedFloor(c: Citizen): number {
  return c.mode === TravelMode.Car ? CAR_FREE_SPEED * 0.6 : WALK_SPEED;
}
