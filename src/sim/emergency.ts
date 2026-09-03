import {
  CRIME_CHANCE_PER_DAY,
  CRIME_OPEN_TICKS,
  CRIME_THEFT_UNITS,
  CRIME_UNSOLVED_PENALTY,
  CRIME_WORK_TICKS,
  EMERGENCY_INTERVAL_MINUTES,
  EMERGENCY_RETRY_TICKS,
  FIRE_BURN_TICKS,
  FIRE_CHANCE_PER_DAY,
  FIRE_INSPECTION_RELIEF,
  FIRE_RISK_INDUSTRIAL,
  FIRE_RISK_POWER,
  FIRE_WORK_TICKS,
  TICKS_PER_DAY,
  UNITS_PER_STATION,
} from '../config';
import { minutesToTicks } from '../core/clock';
import {
  BuildingType,
  Industry,
  TravelMode,
  type BuildingId,
  type IncidentId,
  type TileIndex,
} from '../core/types';
import { industryOf, isHome, isServing, isTransitStop, type Building } from '../world/buildings';
import type { World } from '../world/world';
import { CAR_PROFILE } from './carFollowing';
import { tileCenterX, tileCenterY } from './citizen';
import type { Crossings } from './crossings';
import type { CrimeField } from './crime';
import { advanceVehicle, pathIsBroken, routeToBuilding, setPositionFromPath } from './movement';
import type { Occupancy } from './occupancy';
import { Service, type Services } from './services';
import type { Signals } from './signals';
import type { RoadAgent } from './vehicle';

/** Ids for emergency vehicles, above the citizens and the lorries. */
export const UNIT_ID_BASE = 2_000_000;

export const enum IncidentKind {
  Fire = 0,
  Crime = 1,
}

export const enum UnitState {
  /** In the yard, waiting for a call. */
  Idle = 0,
  /** On the road, blue lights on. */
  Responding = 1,
  /** At the address, working. */
  OnScene = 2,
  Returning = 3,
  /** No route to the call; waits and tries again, like a stranded lorry. */
  Stuck = 4,
  /** Its station was demolished. The slot is free for the next one. */
  Retired = 5,
}

/**
 * A fire engine or a patrol car.
 *
 * Deliberately an ordinary `RoadAgent` with no special powers: it queues at
 * the lights and sits in the jam like everything else. That is the whole
 * argument for having emergency services in a traffic simulation at all --
 * response time is not a coverage percentage, it is the road network the
 * player built, and a station on the wrong side of a congested corridor is a
 * station that does not work.
 */
export interface EmergencyUnit extends RoadAgent {
  kind: IncidentKind;
  /** The station it belongs to, or -1 once retired. */
  home: BuildingId;
  state: UnitState;
  /** The call being answered, or -1. */
  incident: IncidentId;
  /** Tick it may act again: leave the scene, or retry a route. */
  resumeAtTick: number;
  /** Ticks the last completed call took from alarm to arrival. */
  lastResponseTicks: number;
  calls: number;
}

/**
 * Something going wrong at one building.
 *
 * A fire and a burglary are the same shape -- an address, a clock, and
 * somebody who has to get there -- so they are one record with one deadline
 * rather than two systems. What differs is what happens when the deadline
 * passes, and that is one switch at the bottom of this file.
 */
export interface Incident {
  id: IncidentId;
  kind: IncidentKind;
  building: BuildingId;
  tile: TileIndex;
  startTick: number;
  /** Tick this becomes a loss if nobody has got there. */
  deadlineTick: number;
  /** The unit assigned, or -1 while the call is still unanswered. */
  unit: number;
  /** Tick a unit reached the scene, or -1. */
  arrivedTick: number;
}

export interface EmergencyReport {
  fires: number;
  crimes: number;
  /** Calls with nobody assigned to them right now. */
  unanswered: number;
  unitsOut: number;
  /** Since the day's books were last closed. */
  firesToday: number;
  buildingsLostToday: number;
  crimesToday: number;
  crimesSolvedToday: number;
  /** Mean alarm-to-arrival time of the calls answered today, in ticks. */
  meanResponseTicks: number;
}

/**
 * Fires and crime: the first things in this simulation that happen *to* the
 * player rather than because of them.
 *
 * Both are answered by driving a vehicle to an address, which is the point.
 * A fire station is not a radius that makes a number go up; it is a yard with
 * two engines in it, and whether they arrive in time is decided by the same
 * roads, the same lights and the same traffic as everybody else's journey.
 * Ignore the alarm and the building is gone -- with the jobs or the homes
 * that were in it.
 */
export class Emergency {
  report: EmergencyReport = emptyReport();

  private readonly incidents = new Map<IncidentId, Incident>();
  private nextIncidentId = 0;

  private firesToday = 0;
  private lostToday = 0;
  private crimesToday = 0;
  private solvedToday = 0;
  private responses = 0;
  private responseTicks = 0;

  /** Live calls, worst (oldest) first, for the panel. */
  get active(): Incident[] {
    return [...this.incidents.values()].sort((a, b) => a.startTick - b.startTick);
  }

  incidentAt(building: BuildingId): Incident | null {
    for (const incident of this.incidents.values()) {
      if (incident.building === building) return incident;
    }
    return null;
  }

  // --- Rolling for trouble -------------------------------------------------

  /**
   * Roll for new fires and crimes. Runs on a slow cadence, and draws from the
   * world RNG rather than `Math.random`, so a saved city that is reloaded and
   * run again burns down in exactly the same order.
   */
  spawn(world: World, crime: CrimeField, services: Services, tick: number): void {
    const share = minutesToTicks(EMERGENCY_INTERVAL_MINUTES) / TICKS_PER_DAY;

    for (const b of world.buildings) {
      // A platform and a bus shelter have little to burn -- and a fire that
      // took one out would withdraw a whole line as a side effect, which is a
      // punishment for something the player did not do.
      if (!b.alive || isTransitStop(b.type)) continue;
      if (this.incidentAt(b.id)) continue;

      const covered = services.covers(Service.Fire, b.accessRoad);
      const fire = FIRE_CHANCE_PER_DAY * fireRisk(b) * (covered ? FIRE_INSPECTION_RELIEF : 1);
      if (world.rng.next() < fire * share) {
        this.raise(b, IncidentKind.Fire, tick, FIRE_BURN_TICKS);
        this.firesToday++;
        continue;
      }

      // Only somewhere worth robbing: a home, a shop, or an office.
      if (!isRobbable(b)) continue;
      const risk = crime.at(b.tile) / 100;
      if (world.rng.next() < CRIME_CHANCE_PER_DAY * risk * share) {
        this.raise(b, IncidentKind.Crime, tick, CRIME_OPEN_TICKS);
        this.crimesToday++;
      }
    }
  }

  /**
   * Start an incident at a building.
   *
   * Public because the roll above is the only randomness in the whole system:
   * a test (or a scenario) that wants to ask what happens *after* the alarm
   * goes off needs to be able to raise one without waiting for the dice.
   */
  raise(b: Building, kind: IncidentKind, tick: number, window: number): void {
    const id = this.nextIncidentId++;
    this.incidents.set(id, {
      id,
      kind,
      building: b.id,
      tile: b.tile,
      startTick: tick,
      deadlineTick: tick + window,
      unit: -1,
      arrivedTick: -1,
    });
  }

  // --- Dispatch ------------------------------------------------------------

  /**
   * Send the nearest free unit of the right kind to every unanswered call.
   *
   * "Nearest" is measured by the route a vehicle would actually drive, so a
   * station across the river is not near at all -- and a call nobody can reach
   * simply stays unanswered until the player builds the road.
   */
  dispatch(world: World): void {
    this.ensureUnits(world);

    for (const incident of this.active) {
      if (incident.unit >= 0) continue;
      const target = world.buildings[incident.building];
      if (!target || !target.alive) {
        this.incidents.delete(incident.id);
        continue;
      }
      world.refreshAccess(target);

      let best: EmergencyUnit | null = null;
      let bestPath: TileIndex[] | null = null;
      for (const unit of world.units) {
        if (unit.kind !== incident.kind || unit.state !== UnitState.Idle) continue;
        const station = world.buildings[unit.home];
        if (!station || !isServing(station)) continue;
        const path = routeToBuilding(world, unit.x, unit.y, target);
        if (!path) continue;
        if (!bestPath || path.length < bestPath.length) {
          bestPath = path;
          best = unit;
        }
      }
      if (!best || !bestPath) continue;

      const path = bestPath;
      best.incident = incident.id;
      best.state = UnitState.Responding;
      best.path = path;
      best.s = 0;
      best.v = 0;
      best.blockedTicks = 0;
      best.signalHold = -1;
      setPositionFromPath(best);
      incident.unit = best.id;
    }
  }

  /** Every station keeps its yard full; a demolished one gives its slots up. */
  private ensureUnits(world: World): void {
    for (const b of world.buildings) {
      if (!b.alive) continue;
      const kind = kindForStation(b.type);
      if (kind === null) continue;

      let have = 0;
      for (const unit of world.units) {
        if (unit.home === b.id) have++;
      }
      for (; have < UNITS_PER_STATION; have++) {
        const slot = world.units.findIndex((u) => u.state === UnitState.Retired);
        const unit = createUnit(slot >= 0 ? slot : world.units.length, kind, b.id, b.tile);
        if (slot >= 0) world.units[slot] = unit;
        else world.units.push(unit);
      }
    }
  }

  // --- Per tick ------------------------------------------------------------

  /** Publish where every unit is, so they share the road snapshot. */
  forEachDriving(world: World, visit: (unit: EmergencyUnit) => void): void {
    for (const unit of world.units) {
      if (unit.path) visit(unit);
    }
  }

  /**
   * Move the units, work the scenes, and let the clock run out on anything
   * nobody reached.
   */
  step(
    world: World,
    crime: CrimeField,
    occupancy: Occupancy,
    crossings: Crossings,
    signals: Signals,
    tick: number,
  ): void {
    for (const unit of world.units) {
      switch (unit.state) {
        case UnitState.Idle:
        case UnitState.Retired:
          break;

        case UnitState.OnScene:
          if (tick >= unit.resumeAtTick) this.finish(world, unit, tick);
          break;

        case UnitState.Stuck:
          if (tick >= unit.resumeAtTick) this.retry(world, unit, tick);
          break;

        default: {
          if (!unit.path) {
            this.strand(unit, tick);
            break;
          }
          if (pathIsBroken(world, unit)) {
            this.replan(world, unit, tick);
            break;
          }
          if (advanceVehicle(world, unit, occupancy, crossings, signals, tick)) {
            this.arrive(world, unit, tick);
          }
          break;
        }
      }
    }

    this.expire(world, crime, tick);
    this.publish(world);
  }

  private arrive(world: World, unit: EmergencyUnit, tick: number): void {
    unit.path = null;
    unit.v = 0;

    if (unit.state === UnitState.Returning) {
      unit.state = UnitState.Idle;
      return;
    }

    const incident = this.incidents.get(unit.incident);
    if (!incident) {
      this.headHome(world, unit, tick);
      return;
    }
    incident.arrivedTick = tick;
    this.responses++;
    this.responseTicks += tick - incident.startTick;
    unit.lastResponseTicks = tick - incident.startTick;
    unit.state = UnitState.OnScene;
    unit.resumeAtTick = tick
      + (incident.kind === IncidentKind.Fire ? FIRE_WORK_TICKS : CRIME_WORK_TICKS);
  }

  /** The call is dealt with: the fire is out, or the offender is caught. */
  private finish(world: World, unit: EmergencyUnit, tick: number): void {
    const incident = this.incidents.get(unit.incident);
    if (incident) {
      if (incident.kind === IncidentKind.Crime) this.solvedToday++;
      this.incidents.delete(incident.id);
    }
    unit.incident = -1;
    unit.calls++;
    this.headHome(world, unit, tick);
  }

  private headHome(world: World, unit: EmergencyUnit, tick: number): void {
    const station = world.buildings[unit.home];
    if (!station || !station.alive) {
      unit.state = UnitState.Retired;
      unit.home = -1;
      unit.path = null;
      return;
    }
    world.refreshAccess(station);
    const path = routeToBuilding(world, unit.x, unit.y, station);
    if (!path) {
      this.strand(unit, tick);
      return;
    }
    unit.state = UnitState.Returning;
    unit.path = path;
    unit.s = 0;
    unit.v = 0;
    setPositionFromPath(unit);
  }

  private replan(world: World, unit: EmergencyUnit, tick: number): void {
    const incident = this.incidents.get(unit.incident);
    const target = unit.state === UnitState.Responding && incident
      ? world.buildings[incident.building]
      : world.buildings[unit.home];
    if (!target || !target.alive) {
      this.headHome(world, unit, tick);
      return;
    }
    world.refreshAccess(target);
    const path = routeToBuilding(world, unit.x, unit.y, target);
    if (!path) {
      this.strand(unit, tick);
      return;
    }
    unit.path = path;
    unit.s = 0;
    unit.v = 0;
    setPositionFromPath(unit);
  }

  private strand(unit: EmergencyUnit, tick: number): void {
    unit.state = UnitState.Stuck;
    unit.path = null;
    unit.v = 0;
    unit.resumeAtTick = tick + EMERGENCY_RETRY_TICKS;
  }

  private retry(world: World, unit: EmergencyUnit, tick: number): void {
    const incident = this.incidents.get(unit.incident);
    if (incident) {
      const target = world.buildings[incident.building];
      if (target && target.alive) {
        world.refreshAccess(target);
        const path = routeToBuilding(world, unit.x, unit.y, target);
        if (path) {
          unit.state = UnitState.Responding;
          unit.path = path;
          unit.s = 0;
          unit.v = 0;
          setPositionFromPath(unit);
          return;
        }
      }
      // Nobody can get there. Release the call so another station may try.
      incident.unit = -1;
      unit.incident = -1;
    }
    this.headHome(world, unit, tick);
  }

  /**
   * The deadline passed with nobody on scene.
   *
   * This is where a city without a fire brigade actually loses something: the
   * building goes, and with it the homes or the jobs that were inside. A
   * burglary nobody answered empties a shop's shelves and leaves the
   * neighbourhood feeling worse, which raises the crime there and makes the
   * next one likelier -- a spiral the player breaks with a police station.
   */
  private expire(world: World, crime: CrimeField, tick: number): void {
    for (const incident of this.incidents.values()) {
      if (incident.arrivedTick >= 0) continue;
      if (tick < incident.deadlineTick) continue;

      const b = world.buildings[incident.building];
      if (incident.kind === IncidentKind.Fire) {
        if (b && b.alive) world.demolish(b.id);
        this.lostToday++;
      } else if (b && b.alive) {
        b.goodsStock = Math.max(0, b.goodsStock - CRIME_THEFT_UNITS);
        crime.addPressure(incident.tile, CRIME_UNSOLVED_PENALTY);
      }

      const unit = unitById(world, incident.unit);
      if (unit) {
        unit.incident = -1;
        this.headHome(world, unit, tick);
      }
      this.incidents.delete(incident.id);
    }
  }

  private publish(world: World): void {
    let fires = 0;
    let crimes = 0;
    let unanswered = 0;
    for (const incident of this.incidents.values()) {
      if (incident.kind === IncidentKind.Fire) fires++;
      else crimes++;
      if (incident.unit < 0) unanswered++;
    }
    let unitsOut = 0;
    for (const unit of world.units) {
      if (unit.state === UnitState.Responding || unit.state === UnitState.OnScene) unitsOut++;
    }

    this.report = {
      fires,
      crimes,
      unanswered,
      unitsOut,
      firesToday: this.firesToday,
      buildingsLostToday: this.lostToday,
      crimesToday: this.crimesToday,
      crimesSolvedToday: this.solvedToday,
      meanResponseTicks: this.responses === 0 ? 0 : this.responseTicks / this.responses,
    };
  }

  /** Reset the daily counters when the books close. */
  endDay(): void {
    this.firesToday = 0;
    this.lostToday = 0;
    this.crimesToday = 0;
    this.solvedToday = 0;
    this.responses = 0;
    this.responseTicks = 0;
  }

  // --- Save / load ---------------------------------------------------------

  snapshot(): Incident[] {
    return this.active.map((i) => ({ ...i }));
  }

  restore(incidents: Incident[]): void {
    this.incidents.clear();
    let next = 0;
    for (const incident of incidents) {
      this.incidents.set(incident.id, { ...incident });
      next = Math.max(next, incident.id + 1);
    }
    this.nextIncidentId = next;
  }
}

export function createUnit(
  index: number,
  kind: IncidentKind,
  home: BuildingId,
  tile: TileIndex,
): EmergencyUnit {
  return {
    id: UNIT_ID_BASE + index,
    mode: TravelMode.Car,
    profile: CAR_PROFILE,
    path: null,
    s: 0,
    v: 0,
    x: tileCenterX(tile),
    y: tileCenterY(tile),
    prevX: tileCenterX(tile),
    prevY: tileCenterY(tile),
    blockedTicks: 0,
    signalHold: -1,

    kind,
    home,
    state: UnitState.Idle,
    incident: -1,
    resumeAtTick: 0,
    lastResponseTicks: 0,
    calls: 0,
  };
}

function unitById(world: World, id: number): EmergencyUnit | undefined {
  if (id < UNIT_ID_BASE) return undefined;
  return world.units[id - UNIT_ID_BASE];
}

/** Which service answers the calls this station takes. */
export function kindForStation(type: BuildingType): IncidentKind | null {
  if (type === BuildingType.FireStation) return IncidentKind.Fire;
  if (type === BuildingType.PoliceStation) return IncidentKind.Crime;
  return null;
}

/** How much likelier than a house this building is to catch fire. */
function fireRisk(b: Building): number {
  if (b.type === BuildingType.PowerPlant) return FIRE_RISK_POWER;
  const industry = industryOf(b.type);
  if (industry === Industry.Secondary || industry === Industry.Primary) {
    return FIRE_RISK_INDUSTRIAL;
  }
  return 1;
}

/** Somewhere with something to steal: a home, a shop, or an office. */
function isRobbable(b: Building): boolean {
  return isHome(b.type)
    || industryOf(b.type) === Industry.Retail
    || industryOf(b.type) === Industry.Tertiary;
}

function emptyReport(): EmergencyReport {
  return {
    fires: 0,
    crimes: 0,
    unanswered: 0,
    unitsOut: 0,
    firesToday: 0,
    buildingsLostToday: 0,
    crimesToday: 0,
    crimesSolvedToday: 0,
    meanResponseTicks: 0,
  };
}
