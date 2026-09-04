import { Vector3 } from 'three';
import { Rng } from '../core/rng';
import { BuildingType } from '../core/types';
import { specFor } from '../world/buildings';
import type { Vehicle } from '../track/sim/traffic';
import {
  createBuilding,
  doorstep,
  hasVacancy,
  isHome,
  isWorkplace,
  reattachBuildings,
  type CityBuilding,
} from './buildings';
import {
  CAR_OWNERSHIP,
  createCitizen,
  CitizenState,
  departForHomeMinute,
  departForWorkMinute,
  inDepartureWindow,
  WALK_SPEED,
  type CityCitizen,
} from './citizens';
import { Treasury, type TreasurySave } from './economy';
import { findLaneRoute, laneStopsNear, type LaneRoute } from './routing';
import type { LineId } from '../track/network/line';
import type { ZoneType } from '../track/network/zoning';
import {
  capacityOf,
  isBoardable,
  JourneyLeg,
  MAX_WAIT_MINUTES,
  planJourney,
} from './transit';
import type { CityWorld } from './world';

/**
 * The city, running.
 *
 * The systems are the tile city's, because none of them were ever about
 * tiles: demand builds and abandons, people take the jobs that exist, they
 * travel, and how the travelling went decides whether they stay. What is new
 * is the ground they run on -- plots derived from the roads, and trips that
 * are routes through the lane graph driven by real vehicles in the engine's
 * own traffic model.
 *
 * ## One clock
 *
 * The engine's vehicles move in metres per second, and a city needs a day to
 * pass in minutes rather than hours. Both are driven from the same number:
 * `SIM_MINUTES_PER_SECOND` at speed x1, with the speed multiplier applied to
 * the *traffic as well as the clock*. The ratio between "how long the drive
 * took" and "what time it is" therefore never changes with the speed setting
 * -- which is what stops a city that is fine at x1 from failing at x10.
 */

/**
 * Sim minutes per second of world time at x1.
 *
 * This is the exchange rate between the clock and the physics, and it is the
 * one number that decides whether a commute reads as a commute. The vehicles
 * move at real speeds -- a small road is 12 m/s -- so at one minute per second
 * a kilometre of driving took eighty minutes of the day and a five hundred
 * metre walk took six hours, which is not a city, it is a diorama with a
 * broken clock. At a sixth of that, a drive across the town is a quarter of an
 * hour and the walk is an hour: still generous to the car, but the shape of a
 * real journey, and the shape is what the player is deciding about.
 *
 * A day is 8640 seconds of world time, which is two and a half hours at x1 and
 * under five minutes at x30 -- hence the two fast settings.
 */
export const SIM_MINUTES_PER_SECOND = 1 / 6;

/** Pause, slow, normal, fast, very fast. */
export const SPEEDS = [0, 1, 3, 10, 30] as const;
export const DEFAULT_SPEED = 3;

/** The traffic model integrates at no more than this [s]. */
const TRAFFIC_MAX_STEP = 0.1;

/** How long after their departure minute somebody still counts as leaving. */
const DEPARTURE_WINDOW = 40;
/** A stranded citizen waits this long before looking for a route again. */
const STRANDED_RETRY = 90;

/** Growth and the books run on these cadences [sim minutes]. */
const GROWTH_INTERVAL = 60;
const MIGRATION_INTERVAL = 60;
const WELLBEING_INTERVAL = 60;

/** Buildings put up per growth step, so a city fills in rather than appears. */
const BUILDINGS_PER_STEP = 4;

/** Jobs are kept this far ahead of the workforce before more are built. */
const JOB_SURPLUS = 0.15;

/** People arrive at this rate per sim hour when the city is worth moving to. */
const MOVE_IN_PER_HOUR = 6;

/** Sustained misery before somebody leaves [sim hours]. */
const PATIENCE_HOURS = 36;
const UNHAPPY_THRESHOLD = 30;

/** A commute this long [sim minutes] scores nothing. */
const COMMUTE_MISERY = 75;

/** The time of day a new city opens at [sim minutes]. */
export const OPENING_MINUTE = 6 * 60;

/** A trip still going after this long [sim minutes] is given up on. */
const ABANDON_AFTER = 240;

export interface CityStats {
  population: number;
  /** Buildings the city has actually put up (not plots it could put one on). */
  buildings: number;
  jobs: number;
  employed: number;
  homes: number;
  travelling: number;
  /** Of those travelling, how many are on a train or waiting for one. */
  onTransit: number;
  stranded: number;
  meanCommute: number;
  happiness: number;
}


/** A saved city, as plain data. */
export interface SimSave {
  minutes: number;
  transitTrips: number;
  nextCitizenSeed: number;
  lastSettledDay: number;
  carOwnership: number;
  rngState: number;
  treasury: TreasurySave;
  buildings: Array<{
    id: number;
    type: BuildingType;
    zone: ZoneType;
    at: [number, number, number];
    access: { segment: number } | null;
    capacity: number;
    occupants: number[];
    alive: boolean;
    powered: boolean;
    rawStock: number;
    goodsStock: number;
    soldToday: number;
    starvedHours: number;
    visitsToday: number;
  }>;
  citizens: Array<{
    id: number;
    seed: number;
    name: string;
    age: number;
    home: number;
    work: number;
    hasCar: boolean;
    happiness: number;
    unhappyHours: number;
    lastTripMinutes: number;
  }>;
}

export class CitySimulation {
  readonly buildings: CityBuilding[] = [];
  readonly citizens: CityCitizen[] = [];
  readonly treasury = new Treasury();
  readonly rng: Rng;

  /**
   * Sim minutes since the city was founded.
   *
   * Starts at six in the morning rather than at midnight: a new city should
   * open with people about to leave for work, not with four hours of empty
   * streets before anything happens.
   */
  minutes = OPENING_MINUTE;
  /** Commutes completed by train since the city was founded. */
  transitTrips = 0;
  speed = DEFAULT_SPEED;

  stats: CityStats = {
    population: 0, buildings: 0, jobs: 0, employed: 0, homes: 0,
    travelling: 0, onTransit: 0, stranded: 0, meanCommute: 0, happiness: 50,
  };

  /** Plots with nothing on them, refreshed with the world. */
  private freeLots: number[] = [];
  private nextCitizenSeed = 0;
  private lastWorldRevision = -1;
  private lastGrowth = -1;
  private lastMigration = -1;
  private lastWellbeing = -1;
  private lastSettledDay = 0;
  /** The opening town is a gift, not a purchase: the first charge is skipped. */
  private charged = false;
  /** Trips that failed to find a vehicle slot, retried next tick. */
  private pending: CityCitizen[] = [];
  /** Riders aboard each vehicle, so a full train leaves somebody behind. */
  private readonly riders = new Map<number, number>();

  /**
   * How many households have a car.
   *
   * A knob rather than a constant because it is the one number that decides
   * whether a line is worth building, and a test that wants to watch people
   * ride should be able to say "this is a town without cars" instead of
   * growing a city big enough to jam.
   */
  carOwnership = CAR_OWNERSHIP;

  constructor(readonly world: CityWorld, seed = 20260903, options: { carOwnership?: number } = {}) {
    this.rng = new Rng(seed);
    if (options.carOwnership !== undefined) this.carOwnership = options.carOwnership;
  }

  get day(): number {
    return Math.floor(this.minutes / 1440);
  }

  get minuteOfDay(): number {
    return Math.floor(this.minutes % 1440);
  }

  format(): string {
    const h = String(Math.floor(this.minuteOfDay / 60)).padStart(2, '0');
    const m = String(Math.floor(this.minuteOfDay % 60)).padStart(2, '0');
    return `Day ${this.day + 1}  ${h}:${m}`;
  }

  /**
   * Advance by `dt` real seconds.
   *
   * The traffic is stepped in slices no larger than the model's own limit,
   * because at x10 a frame is a second of world time and an IDM integrated in
   * one-second jumps drives through the car in front.
   */
  step(dt: number): void {
    const multiplier = SPEEDS[this.speed];
    if (multiplier === 0) return;
    const worldSeconds = dt * multiplier;

    if (this.world.revision !== this.lastWorldRevision) {
      this.lastWorldRevision = this.world.revision;
      this.onWorldChanged();
    }

    let remaining = worldSeconds;
    while (remaining > 1e-4) {
      const slice = Math.min(TRAFFIC_MAX_STEP, remaining);
      this.world.traffic.step(slice);
      this.advanceWalkers(slice);
      this.advanceRiders();
      remaining -= slice;
    }

    const before = this.minutes;
    this.minutes += worldSeconds * SIM_MINUTES_PER_SECOND;
    this.runSchedules();
    this.runCity(before);
    this.sample();
  }

  // ------------------------------------------------------------ the world

  /**
   * The network changed under the city: plots moved, and the lane graph the
   * trips were routed over no longer exists.
   *
   * Everybody in a vehicle is put back on the pavement rather than left
   * holding a route into a graph that has been thrown away -- the same rule
   * the tile city had for riders of a line that was withdrawn.
   */
  private onWorldChanged(): void {
    const { free, lost } = reattachBuildings(this.world, this.buildings);
    // Shuffled, and that is not a detail. `grow` takes plots off the front of
    // this list, so in the order the engine derived them the town fills
    // strictly in the order its roads were laid -- the whole city ends up in
    // one corner, and the station at the other end of town never sees a
    // passenger because nobody lives or works near it. Deterministic, from the
    // city's own generator, so a seed still builds the same town.
    this.freeLots = this.rng.shuffled(free);
    this.publishBuiltLots();

    // Whatever the player laid since the last rebuild is charged for now, out
    // of the engine's own figure for what the network cost to build.
    this.treasury.chargeNetwork(this.world.result?.stats.cost ?? 0, !this.charged);
    this.charged = true;

    for (const building of lost) {
      for (const id of building.occupants) {
        const citizen = this.citizens[id];
        if (!citizen) continue;
        if (citizen.home === building.id) this.rehouse(citizen);
        if (citizen.work === building.id) citizen.work = -1;
      }
      building.occupants = [];
    }

    this.riders.clear();
    for (const citizen of this.citizens) {
      citizen.vehicle = -1;
      citizen.walk = null;
      citizen.journey = null;
      if (citizen.state === CitizenState.ToWork || citizen.state === CitizenState.ToHome) {
        // Put them back where they were going from, and let the schedule send
        // them again. Half a trip through a graph that no longer exists is
        // not a position anybody can be at.
        this.sendHome(citizen);
      }
    }
    this.pending.length = 0;
  }

  // -------------------------------------------------------------- schedule

  private runSchedules(): void {
    const minute = this.minuteOfDay;
    for (const citizen of this.citizens) {
      if (citizen.left) continue;
      switch (citizen.state) {
        case CitizenState.AtHome:
          if (
            citizen.work >= 0
            && inDepartureWindow(minute, departForWorkMinute(citizen.seed), DEPARTURE_WINDOW)
          ) {
            this.beginTrip(citizen, CitizenState.ToWork);
          }
          break;
        case CitizenState.AtWork:
          if (inDepartureWindow(minute, departForHomeMinute(citizen.seed), DEPARTURE_WINDOW)) {
            this.beginTrip(citizen, CitizenState.ToHome);
          }
          break;
        case CitizenState.Stranded:
          if (this.minutes >= citizen.retryAtMinute) {
            this.beginTrip(citizen, CitizenState.ToWork);
          }
          break;
        default:
          break;
      }
    }

    this.abandonHopelessTrips();

    // Trips that could not be started (no room on the road yet) try again.
    const waiting = this.pending.splice(0, this.pending.length);
    for (const citizen of waiting) this.startVehicle(citizen);
  }

  /**
   * Nobody sits in a jam for ever.
   *
   * A trip that has run this long is not going to finish: the network cannot
   * carry what the city is asking of it. Rather than leave the citizen on the
   * road for the rest of the week -- and their car in the queue making it
   * worse -- they give up and go home, and the city counts them as stranded.
   * That is the reading the player needs: the stranded figure is the number of
   * people whose journey the roads could not deliver.
   */
  private abandonHopelessTrips(): void {
    for (const citizen of this.citizens) {
      if (citizen.state !== CitizenState.ToWork && citizen.state !== CitizenState.ToHome) continue;
      if (this.minutes - citizen.tripStartMinute < ABANDON_AFTER) continue;
      if (citizen.vehicle >= 0 && !citizen.journey) {
        this.world.traffic.remove(citizen.vehicle);
      }
      this.strand(citizen);
    }
  }

  /** Set off. The route is found now; the vehicle may have to wait for room. */
  private beginTrip(citizen: CityCitizen, state: CitizenState.ToWork | CitizenState.ToHome): void {
    const fromId = state === CitizenState.ToWork ? citizen.home : citizen.work;
    const toId = state === CitizenState.ToWork ? citizen.work : citizen.home;
    const from = this.buildings[fromId];
    const to = this.buildings[toId];
    if (!from?.alive || !to?.alive || !from.access || !to.access) {
      this.strand(citizen);
      return;
    }

    const route = this.routeBetween(from, to);
    if (!route) {
      this.strand(citizen);
      return;
    }

    citizen.state = state;
    citizen.tripStartMinute = this.minutes;
    citizen.route = route;
    citizen.journey = null;

    // Which way to go. Somebody without a car takes the train if there is one
    // and walks the whole way if there is not; somebody with a car takes the
    // train only when it is genuinely quicker than driving. That is the whole
    // reason to build a line: it has to beat the road on its merits.
    const drive = route.seconds / 60;
    const journey = citizen.hasCar || this.transitOffered(citizen)
      ? planJourney(this.world, from, to)
      : null;
    if (journey && (!citizen.hasCar || journey.journey.minutes < drive)) {
      citizen.journey = journey.journey;
      citizen.journey.waitingSince = this.minutes;
      citizen.walk = { route: journey.access, travelled: 0 };
      return;
    }

    if (citizen.hasCar) this.startVehicle(citizen);
    else citizen.walk = { route, travelled: 0 };
  }

  /**
   * Whether it is worth looking for a train for somebody on foot.
   *
   * Only that there are lines at all -- the search itself decides the rest.
   * Kept separate so the common case (no lines yet) costs nothing.
   */
  private transitOffered(citizen: CityCitizen): boolean {
    void citizen;
    return (this.world.result?.lines.length ?? 0) > 0;
  }

  /** Put a car on the road for a citizen whose route is already found. */
  private startVehicle(citizen: CityCitizen): void {
    const route = citizen.route;
    if (!route || citizen.state === CitizenState.AtHome || citizen.state === CitizenState.AtWork) {
      return;
    }
    const vehicle = this.world.traffic.addTrip(
      route.lanes,
      this.startOffset(route),
      (v) => this.arrive(citizen, v),
    );
    if (vehicle) citizen.vehicle = vehicle.id;
    // No room at the kerb this instant: wait a beat and try again, rather
    // than appearing inside the car that is already there.
    else this.pending.push(citizen);
  }

  /** Where on its first lane a car joins: at the door it set off from. */
  private startOffset(route: LaneRoute): number {
    const lane = this.world.laneGraph.lanes[route.lanes[0]];
    if (!lane) return 0;
    return Math.max(0, Math.min(route.startS, lane.path.length - 0.5));
  }

  private arrive(citizen: CityCitizen, vehicle: Vehicle): void {
    citizen.vehicle = -1;
    citizen.at.copy(vehicle.bodies[0]?.pos ?? citizen.at);
    this.finishTrip(citizen);
  }

  private advanceWalkers(dt: number): void {
    for (const citizen of this.citizens) {
      const walk = citizen.walk;
      if (!walk) continue;
      walk.travelled += WALK_SPEED * dt;
      const at = this.pointAlong(walk.route, walk.travelled);
      if (at) citizen.at.copy(at);
      if (walk.travelled >= walk.route.length) {
        citizen.walk = null;
        const journey = citizen.journey;
        if (journey?.leg === JourneyLeg.ToStation) {
          // On the platform. The trip is not over; it has barely started.
          journey.leg = JourneyLeg.Waiting;
          journey.waitingSince = this.minutes;
          const station = this.world.net.stations.get(journey.board);
          if (station) citizen.at.copy(station.center);
        } else {
          this.finishTrip(citizen);
        }
      }
    }
  }

  /**
   * The platform and the ride.
   *
   * Boarding is not a schedule lookup: a rider gets on the train that is
   * standing at their station with its doors open, on their line, with room.
   * Getting off is the same rule at the other end. Everything in between is
   * the traffic model driving the train, and a rider who is on it goes exactly
   * where it goes -- including nowhere, if it is stuck.
   */
  private advanceRiders(): void {
    const vehicles = this.world.traffic.vehicles;
    const byId = new Map<number, Vehicle>();
    for (const vehicle of vehicles) byId.set(vehicle.id, vehicle);

    for (const citizen of this.citizens) {
      const journey = citizen.journey;
      if (!journey) continue;

      if (journey.leg === JourneyLeg.Waiting) {
        const train = vehicles.find(
          (v) => isBoardable(v, journey.line, journey.board)
            && (this.riders.get(v.id) ?? 0) < capacityOf(v),
        );
        if (train) {
          this.riders.set(train.id, (this.riders.get(train.id) ?? 0) + 1);
          citizen.vehicle = train.id;
          journey.leg = JourneyLeg.Riding;
        } else if (this.minutes - journey.waitingSince > MAX_WAIT_MINUTES) {
          // The train never came. Give up on it rather than wait for ever:
          // walk the rest of the way if the route is still there, and be
          // stranded (and unhappy about it) if it is not.
          citizen.journey = null;
          if (citizen.route) citizen.walk = { route: citizen.route, travelled: 0 };
          else this.strand(citizen);
        }
        continue;
      }

      if (journey.leg !== JourneyLeg.Riding) continue;

      const train = byId.get(citizen.vehicle);
      if (!train) {
        // The train was withdrawn under them. Put them on the pavement where
        // they last were rather than deleting the trip.
        this.alight(citizen);
        if (journey.egress) citizen.walk = { route: journey.egress, travelled: 0 };
        else this.strand(citizen);
        citizen.journey = null;
        continue;
      }
      if (train.bodies[0]) citizen.at.copy(train.bodies[0].pos);
      if (isBoardable(train, journey.line, journey.alight)) {
        this.alight(citizen);
        const station = this.world.net.stations.get(journey.alight);
        if (station) citizen.at.copy(station.center);
        journey.leg = JourneyLeg.FromStation;
        if (journey.egress) citizen.walk = { route: journey.egress, travelled: 0 };
        else this.finishTrip(citizen);
      }
    }
  }

  /** Off the train, and out of its rider count. */
  private alight(citizen: CityCitizen): void {
    const aboard = this.riders.get(citizen.vehicle);
    if (aboard !== undefined) {
      if (aboard <= 1) this.riders.delete(citizen.vehicle);
      else this.riders.set(citizen.vehicle, aboard - 1);
    }
    citizen.vehicle = -1;
  }

  /** Where a route reaches after `travelled` metres. */
  private pointAlong(route: LaneRoute, travelled: number): Vector3 | null {
    let left = travelled;
    for (const id of route.lanes) {
      const lane = this.world.laneGraph.lanes[id];
      if (!lane) return null;
      if (left <= lane.path.length) return lane.path.poseAt(Math.max(0, left)).pos.clone();
      left -= lane.path.length;
    }
    return null;
  }

  private finishTrip(citizen: CityCitizen): void {
    citizen.lastTripMinutes = Math.max(0, this.minutes - citizen.tripStartMinute);
    citizen.route = null;
    if (citizen.journey) this.transitTrips++;
    citizen.journey = null;
    citizen.state = citizen.state === CitizenState.ToWork
      ? CitizenState.AtWork
      : CitizenState.AtHome;
    const building = this.buildings[
      citizen.state === CitizenState.AtWork ? citizen.work : citizen.home
    ];
    if (building?.alive) citizen.at.copy(building.at);
  }

  private strand(citizen: CityCitizen): void {
    citizen.state = CitizenState.Stranded;
    if (citizen.vehicle >= 0) this.alight(citizen);
    citizen.vehicle = -1;
    citizen.walk = null;
    citizen.route = null;
    citizen.journey = null;
    citizen.retryAtMinute = this.minutes + STRANDED_RETRY;
    const home = this.buildings[citizen.home];
    if (home?.alive) citizen.at.copy(home.at);
  }

  private sendHome(citizen: CityCitizen): void {
    citizen.state = CitizenState.AtHome;
    citizen.route = null;
    citizen.journey = null;
    const home = this.buildings[citizen.home];
    if (home?.alive) citizen.at.copy(home.at);
  }

  /** A car route from one building's door to another's. */
  private routeBetween(from: CityBuilding, to: CityBuilding): LaneRoute | null {
    const graph = this.world.laneGraph;
    const fromAt = doorstep(this.world, from) ?? from.at;
    const toAt = doorstep(this.world, to) ?? to.at;
    const starts = laneStopsNear(graph, from.access!.segment, fromAt);
    const ends = laneStopsNear(graph, to.access!.segment, toAt);
    if (starts.length === 0 || ends.length === 0) return null;
    return findLaneRoute(graph, { from: starts, to: ends, kind: 'car' });
  }

  // ------------------------------------------------------------- the city

  private runCity(beforeMinutes: number): void {
    if (this.due(beforeMinutes, GROWTH_INTERVAL, 'lastGrowth')) {
      this.grow();
      this.assignJobs();
    }
    if (this.due(beforeMinutes, WELLBEING_INTERVAL, 'lastWellbeing')) {
      this.updateWellbeing();
    }
    if (this.due(beforeMinutes, MIGRATION_INTERVAL, 'lastMigration')) {
      this.migrate();
    }
    // The books close at midnight.
    if (this.day !== this.lastSettledDay) {
      this.lastSettledDay = this.day;
      this.treasury.settleDay({
        employed: this.stats.employed,
        population: this.stats.population,
        upkeep: this.upkeep,
      });
    }
  }

  private due(
    before: number,
    everyMinutes: number,
    field: 'lastGrowth' | 'lastMigration' | 'lastWellbeing',
  ): boolean {
    const bucket = Math.floor(this.minutes / everyMinutes);
    if (bucket === this[field]) return false;
    // Never run twice for the same bucket, and never skip one because a slow
    // frame stepped over it.
    this[field] = bucket;
    return before >= 0;
  }

  /**
   * Put up buildings where demand wants them.
   *
   * Housing goes up while people want to move in; workplaces go up while the
   * workforce is short of jobs. It is the tile city's rule, applied to plots.
   */
  private grow(): void {
    if (this.freeLots.length === 0) return;
    const wantHomes = this.stats.population + 8 > this.housingCapacity();
    const wantJobs = this.jobCount() < this.stats.population * (1 + JOB_SURPLUS);

    let built = 0;
    for (let i = 0; i < this.freeLots.length && built < BUILDINGS_PER_STEP; i++) {
      const index = this.freeLots[i];
      const lot = this.world.lots[index];
      if (!lot) continue;
      const home = lot.zone === 'residential' || lot.zone === 'apartment';
      if (home && !wantHomes) continue;
      if (!home && !wantJobs) continue;

      const building = createBuilding(this.buildings.length, lot, index);
      building.access = { segment: lot.segment, at: lot.center.clone() };
      building.powered = true;
      this.buildings.push(building);
      this.freeLots.splice(i, 1);
      i--;
      built++;
    }
    // Show what was built. Only the building meshes are redone: rebuilding
    // the world for one house would redo every junction and every cutting.
    if (built > 0) this.publishBuiltLots();
  }

  /**
   * Tell the renderer which plots have a building on them.
   *
   * The engine draws a building on every painted plot, which is right for an
   * editor and wrong for a city: here a plot is somewhere a building *may*
   * appear, and demand decides when. Without this the town looks finished
   * before anybody has moved in.
   */
  private publishBuiltLots(): void {
    const built = new Set<number>();
    for (const building of this.buildings) {
      if (building.alive && building.lot >= 0) built.add(building.lot);
    }
    this.world.builder.builtLots = built;
    this.world.builder.refreshBuildings();
  }

  /** Everybody without a job takes one, nearest-ish first. */
  private assignJobs(): void {
    const openings = this.buildings.filter((b) => b.alive && isWorkplace(b) && hasVacancy(b));
    if (openings.length === 0) return;
    for (const citizen of this.citizens) {
      if (citizen.work >= 0 && this.buildings[citizen.work]?.alive) continue;
      const home = this.buildings[citizen.home];
      if (!home?.alive) continue;
      // Weighted towards the near ones rather than always the nearest: strict
      // nearest-first puts everybody a block from home and no road ever
      // carries anybody, which is the mistake the tile city made first.
      const pool = openings.filter(hasVacancy).slice(0, 40);
      if (pool.length === 0) return;
      let best: CityBuilding | null = null;
      let bestScore = -Infinity;
      for (const candidate of pool) {
        const d = candidate.at.distanceTo(home.at);
        const score = -d * (0.6 + this.rng.next() * 0.8);
        if (score > bestScore) {
          bestScore = score;
          best = candidate;
        }
      }
      if (!best) return;
      best.occupants.push(citizen.id);
      citizen.work = best.id;
    }
  }

  /** How everybody feels, and how long their last trip took. */
  private updateWellbeing(): void {
    for (const citizen of this.citizens) {
      const employed = citizen.work >= 0 && (this.buildings[citizen.work]?.alive ?? false);
      const housed = this.buildings[citizen.home]?.alive ?? false;
      // The trip that counts is the worse of "the last one I finished" and
      // "the one I am still on". Judging people only on finished trips means
      // somebody who has been on the road since breakfast and has not arrived
      // is scored as though their commute were fine -- which is exactly
      // backwards, and it let a gridlocked city report itself content and go
      // on attracting people into the jam.
      const travelling = citizen.state === CitizenState.ToWork
        || citizen.state === CitizenState.ToHome;
      const worst = Math.max(
        citizen.lastTripMinutes,
        travelling ? this.minutes - citizen.tripStartMinute : 0,
      );
      // Allowed to go negative, and that is the point. Floored at zero, being
      // housed and employed is worth 65 whatever the roads are like, so no
      // amount of gridlock could ever make the city unattractive and the
      // population only ever went up. A commute bad enough has to be able to
      // outweigh having somewhere to live.
      const commute = worst > 0
        ? Math.max(-100, 100 - (worst / COMMUTE_MISERY) * 100)
        : 70;
      const score = clamp(
        (housed ? 45 : 0)
        + (employed ? 20 : 5)
        + commute * 0.35
        - (citizen.state === CitizenState.Stranded ? 40 : 0),
      );
      citizen.happiness = citizen.happiness < 0
        ? score
        : citizen.happiness + (score - citizen.happiness) * 0.3;
      citizen.unhappyHours = citizen.happiness < UNHAPPY_THRESHOLD
        ? citizen.unhappyHours + 1
        : 0;
    }
  }

  /** People arrive when the city is worth moving to, and leave when it is not. */
  private migrate(): void {
    for (const citizen of this.citizens) {
      if (citizen.unhappyHours < PATIENCE_HOURS) continue;
      this.detach(citizen);
      citizen.left = true;
    }
    if (this.citizens.some((c) => c.left)) this.compact();

    const attractiveness = (this.stats.happiness - 35) / 40;
    if (attractiveness <= 0) return;
    const room = Math.round(MOVE_IN_PER_HOUR * Math.min(1, attractiveness));
    this.moveIn(room);
  }

  private moveIn(wanted: number): void {
    let moved = 0;
    for (const building of this.buildings) {
      if (moved >= wanted) break;
      if (!building.alive || !isHome(building)) continue;
      while (moved < wanted && hasVacancy(building)) {
        const id = this.citizens.length;
        const citizen = createCitizen(
          id,
          this.nextCitizenSeed++,
          building.id,
          building.at,
          this.rng,
          this.carOwnership,
        );
        this.citizens.push(citizen);
        building.occupants.push(id);
        moved++;
      }
    }
  }

  /** Somebody whose home has gone takes the first empty dwelling, or leaves. */
  private rehouse(citizen: CityCitizen): void {
    for (const building of this.buildings) {
      if (!building.alive || !isHome(building) || !hasVacancy(building)) continue;
      building.occupants.push(citizen.id);
      citizen.home = building.id;
      citizen.state = CitizenState.AtHome;
      citizen.at.copy(building.at);
      return;
    }
    citizen.left = true;
  }

  private detach(citizen: CityCitizen): void {
    for (const id of [citizen.home, citizen.work]) {
      const building = this.buildings[id];
      if (!building) continue;
      const at = building.occupants.indexOf(citizen.id);
      if (at >= 0) building.occupants.splice(at, 1);
    }
  }

  /**
   * Actually remove departed citizens, renumbering the survivors.
   *
   * Ids are array indices held by buildings, so this is the one place that
   * renumbers -- which is why departures are batched into the hourly pass
   * rather than done the moment somebody gives up.
   */
  private compact(): void {
    const remap = new Map<number, number>();
    const survivors: CityCitizen[] = [];
    for (const citizen of this.citizens) {
      if (citizen.left) continue;
      remap.set(citizen.id, survivors.length);
      citizen.id = survivors.length;
      survivors.push(citizen);
    }
    this.citizens.length = 0;
    this.citizens.push(...survivors);
    for (const building of this.buildings) {
      if (building.occupants.length === 0) continue;
      building.occupants = building.occupants
        .map((id) => remap.get(id) ?? -1)
        .filter((id) => id >= 0);
    }
  }

  // -------------------------------------------------------------- readouts

  private sample(): void {
    let employed = 0;
    let travelling = 0;
    let onTransit = 0;
    let stranded = 0;
    let commuteTotal = 0;
    let commuteCount = 0;
    let happiness = 0;
    for (const citizen of this.citizens) {
      if (citizen.work >= 0) employed++;
      if (citizen.state === CitizenState.ToWork || citizen.state === CitizenState.ToHome) {
        travelling++;
        if (citizen.journey) onTransit++;
      }
      if (citizen.state === CitizenState.Stranded) stranded++;
      if (citizen.lastTripMinutes > 0) {
        commuteTotal += citizen.lastTripMinutes;
        commuteCount++;
      }
      if (citizen.happiness >= 0) happiness += citizen.happiness;
    }
    const people = Math.max(1, this.citizens.length);
    this.stats = {
      population: this.citizens.length,
      buildings: this.buildings.reduce((n, b) => n + (b.alive ? 1 : 0), 0),
      jobs: this.jobCount(),
      employed,
      homes: this.buildings.filter((b) => b.alive && isHome(b)).length,
      travelling,
      onTransit,
      stranded,
      meanCommute: commuteCount === 0 ? 0 : commuteTotal / commuteCount,
      happiness: this.citizens.length === 0 ? 50 : happiness / people,
    };
  }

  private housingCapacity(): number {
    let total = 0;
    for (const b of this.buildings) if (b.alive && isHome(b)) total += b.capacity;
    return total;
  }

  private jobCount(): number {
    let total = 0;
    for (const b of this.buildings) if (b.alive && isWorkplace(b)) total += b.capacity;
    return total;
  }

  // ------------------------------------------------------------- saving

  /**
   * Everything about the city that is not derivable from the world.
   *
   * Deliberately small. The terrain comes back from its seed, the plots and
   * the lane graph are rebuilt from the network, and a trip in progress is not
   * saved at all -- a loaded city starts with everybody at home or at work,
   * because half a journey through a lane graph that has yet to be built is
   * not a position anybody can be restored to. The generator's stream position
   * *is* saved: without it a loaded city replays the draws the save already
   * made, and grows the same buildings again.
   */
  capture(): SimSave {
    return {
      minutes: this.minutes,
      transitTrips: this.transitTrips,
      nextCitizenSeed: this.nextCitizenSeed,
      lastSettledDay: this.lastSettledDay,
      carOwnership: this.carOwnership,
      rngState: this.rng.getState(),
      treasury: this.treasury.capture(),
      buildings: this.buildings.map((b) => ({
        id: b.id,
        type: b.type,
        zone: b.zone,
        at: [b.at.x, b.at.y, b.at.z] as [number, number, number],
        access: b.access ? { segment: b.access.segment } : null,
        capacity: b.capacity,
        occupants: [...b.occupants],
        alive: b.alive,
        powered: b.powered,
        rawStock: b.rawStock,
        goodsStock: b.goodsStock,
        soldToday: b.soldToday,
        starvedHours: b.starvedHours,
        visitsToday: b.visitsToday,
      })),
      citizens: this.citizens.map((c) => ({
        id: c.id,
        seed: c.seed,
        name: c.name,
        age: c.age,
        home: c.home,
        work: c.work,
        hasCar: c.hasCar,
        happiness: c.happiness,
        unhappyHours: c.unhappyHours,
        lastTripMinutes: c.lastTripMinutes,
      })),
    };
  }

  /** Become the saved city. The world must already be the saved world. */
  adopt(save: SimSave): void {
    this.minutes = save.minutes;
    this.transitTrips = save.transitTrips;
    this.nextCitizenSeed = save.nextCitizenSeed;
    this.lastSettledDay = save.lastSettledDay;
    this.carOwnership = save.carOwnership;
    this.rng.setState(save.rngState);
    this.treasury.adopt(save.treasury);

    this.buildings.length = 0;
    for (const b of save.buildings) {
      const at = new Vector3(b.at[0], b.at[1], b.at[2]);
      this.buildings.push({
        id: b.id,
        type: b.type,
        zone: b.zone,
        at,
        lot: -1,
        access: b.access ? { segment: b.access.segment, at: at.clone() } : null,
        capacity: b.capacity,
        occupants: [...b.occupants],
        alive: b.alive,
        powered: b.powered,
        rawStock: b.rawStock,
        goodsStock: b.goodsStock,
        soldToday: b.soldToday,
        starvedHours: b.starvedHours,
        visitsToday: b.visitsToday,
      });
    }

    this.citizens.length = 0;
    for (const c of save.citizens) {
      const home = this.buildings[c.home];
      const citizen = createCitizen(
        c.id,
        c.seed,
        c.home,
        home?.at ?? new Vector3(),
        this.rng,
        this.carOwnership,
      );
      citizen.name = c.name;
      citizen.age = c.age;
      citizen.work = c.work;
      citizen.hasCar = c.hasCar;
      citizen.happiness = c.happiness;
      citizen.unhappyHours = c.unhappyHours;
      citizen.lastTripMinutes = c.lastTripMinutes;
      this.citizens.push(citizen);
    }
    // `createCitizen` draws from the generator, so put the stream back where
    // the save left it -- restoring a city must not consume its future.
    this.rng.setState(save.rngState);

    this.pending.length = 0;
    this.riders.clear();
    this.lastGrowth = -1;
    this.lastMigration = -1;
    this.lastWellbeing = -1;
    // The town it starts with is the town it saved, not a purchase: the first
    // charge only records the watermark, and the watermark itself came back
    // with the treasury.
    this.charged = false;
    // Match the buildings to their plots now rather than at the first step, so
    // a loaded city is a whole city before anybody looks at it.
    this.onWorldChanged();
    this.lastWorldRevision = this.world.revision;
    this.sample();
  }

  /**
   * What each line is carrying right now.
   *
   * The panel's whole job is to answer "is this line worth what it costs",
   * and that question is about riders, not about track. Trains come from the
   * traffic model, riders and the platform queue from the citizens -- nothing
   * here is a tally kept on the side that could drift from what is happening.
   */
  lineReport(): Map<LineId, { trains: number; riders: number; waiting: number }> {
    const out = new Map<LineId, { trains: number; riders: number; waiting: number }>();
    const of = (id: LineId) => {
      let entry = out.get(id);
      if (!entry) {
        entry = { trains: 0, riders: 0, waiting: 0 };
        out.set(id, entry);
      }
      return entry;
    };
    for (const plan of this.world.result?.lines ?? []) of(plan.id);
    for (const vehicle of this.world.traffic.vehicles) {
      if (vehicle.line) of(vehicle.line.id).trains++;
    }
    for (const citizen of this.citizens) {
      const journey = citizen.journey;
      if (!journey) continue;
      if (journey.leg === JourneyLeg.Riding) of(journey.line).riders++;
      else if (journey.leg === JourneyLeg.Waiting) of(journey.line).waiting++;
    }
    return out;
  }

  /** Daily upkeep of everything the city keeps: its buildings and its network. */
  get upkeep(): number {
    let total = 0;
    for (const b of this.buildings) if (b.alive) total += specFor(b.type).upkeep;
    // The engine already knows what the network cost to build; keeping it is
    // charged against the same figure so that a sprawling city is expensive
    // to *have*, not only to lay.
    return total + (this.world.result?.stats.totalLength ?? 0) * 0.02;
  }
}

function clamp(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/** The building types the city grows, for anything iterating over them. */
export const GROWN_TYPES: readonly BuildingType[] = [
  BuildingType.House,
  BuildingType.Apartment,
  BuildingType.Shop,
  BuildingType.Office,
  BuildingType.Factory,
  BuildingType.Farm,
  BuildingType.ForestryCamp,
  BuildingType.FishingWharf,
  BuildingType.Mine,
];
