import { MAP_SIZE } from '../config';
import type { CitizenState, TravelMode, BuildingType, TileIndex } from '../core/types';
import type { Citizen } from '../sim/citizen';
import { CAR_PROFILE } from '../sim/carFollowing';
import { createLorry, type CargoKind, type Lorry, type LorryState } from '../sim/lorry';
import { createBus, type Bus } from '../sim/bus';
import {
  createUnit,
  type EmergencyUnit,
  type Incident,
  type IncidentKind,
  type UnitState,
} from '../sim/emergency';
import type { TaxRates } from '../sim/economy';
import { Simulation } from '../sim/simulation';
import { setTrainPosition } from '../sim/trains';
import type { RideLeg } from '../sim/transitPlanner';
import type { Building } from './buildings';
import type { LineMode, TransitLine, Train } from './transit';
import { World } from './world';

export const SAVE_VERSION = 5;
export const SAVE_KEY = 'city-sim.save';

/**
 * The save format.
 *
 * What is *not* here is as deliberate as what is. Signal phases are a pure
 * function of the tick, and occupancy, closed crossings and the path cache are
 * all rebuilt from the first tick after loading, so none of them are written
 * out. Everything that cannot be recomputed is: the map, who lives and works
 * where, the trip each citizen is halfway through, the RNG stream position --
 * and the traffic memory, which is not derivable at all. Dropping that last
 * one would make everybody drive for the first few sim-hours after a load,
 * because every road would look empty; it is as much part of the city as the
 * roads themselves.
 */
export interface SaveData {
  version: number;
  tick: number;
  rngState: number;
  completedTrips: number;
  citizenSeed: number;
  /**
   * The slow-cadence buckets already evaluated, so a load does not re-run
   * growth, re-collect a day's tax, or re-tick the supply chain.
   */
  growthBucket: number;
  powerBucket: number;
  chainBucket: number;
  fieldBucket: number;
  migrationBucket: number;
  freightBucket: number;
  servicesBucket: number;
  emergencyBucket: number;
  settledDay: number;
  money: SavedEconomy;
  /** Base64 of the per-tile float fields (Float32, MAP_SIZE^2 each). */
  traffic: string;
  noise: string;
  landValue: string;
  crime: string;
  /** Base64 of the byte layers, each MAP_SIZE^2 long. */
  terrain: string;
  road: string;
  rail: string;
  zone: string;
  resource: string;
  buildings: SavedBuilding[];
  citizens: SavedCitizen[];
  lines: SavedLine[];
  trains: SavedTrain[];
  lorries: SavedLorry[];
  buses: SavedBus[];
  units: SavedUnit[];
  incidents: Incident[];
}

interface SavedEconomy {
  balance: number;
  debt: number;
  spent: number;
  rates: TaxRates;
}

interface SavedBuilding {
  t: number;
  tile: TileIndex;
  access: TileIndex;
  platform: TileIndex;
  cap: number;
  occ: number[];
  alive: boolean;
  raw: number;
  goods: number;
  sold: number;
  starved: number;
}

interface SavedCitizen {
  seed: number;
  name: string;
  age: number;
  home: number;
  work: number;
  state: number;
  mode: number;
  dest: number;
  s: number;
  v: number;
  x: number;
  y: number;
  trip: number;
  retry: number;
  origin: number;
  leg: number;
  pantry: number;
  shopFailed: boolean;
  nextShop: number;
  blocked: number;
  routing: boolean;
  wait: number;
  lastWait: number;
  train: number;
  education: number;
  hasCar: boolean;
  happy: number;
  unhappy: number;
  lastTrip: number;
  path?: TileIndex[];
  after?: TileIndex[];
  ride?: RideLeg;
}

interface SavedLine {
  name: string;
  color: string;
  mode: number;
  stations: number[];
  route: TileIndex[];
  stopAt: number[];
  stopStation: number[];
  vehicles: number[];
  ridership: number;
}

interface SavedBus {
  line: number;
  nextStop: number;
  dwellUntil: number;
  passengers: number[];
  resume: number;
  s: number;
  v: number;
  x: number;
  y: number;
  blocked: number;
  path?: TileIndex[];
}

interface SavedUnit {
  kind: number;
  home: number;
  state: number;
  incident: number;
  resume: number;
  lastResponse: number;
  calls: number;
  s: number;
  v: number;
  x: number;
  y: number;
  blocked: number;
  path?: TileIndex[];
}

interface SavedLorry {
  state: number;
  home: number;
  dest: number;
  cargo: number;
  cargoKind: number;
  resume: number;
  s: number;
  v: number;
  x: number;
  y: number;
  blocked: number;
  trips: number;
  tripStart: number;
  path?: TileIndex[];
  pending?: TileIndex[];
}

interface SavedTrain {
  line: number;
  s: number;
  v: number;
  nextStop: number;
  dwellUntil: number;
  passengers: number[];
}

// --- Writing ---------------------------------------------------------------

export function serialize(sim: Simulation): SaveData {
  const { world } = sim;
  return {
    version: SAVE_VERSION,
    tick: sim.clock.tick,
    rngState: world.rng.getState(),
    completedTrips: sim.stats.totalCompleted,
    citizenSeed: world.nextCitizenSeed,
    growthBucket: sim.lastGrowthBucket,
    powerBucket: sim.lastPowerBucket,
    chainBucket: sim.lastChainBucket,
    fieldBucket: sim.lastFieldBucket,
    migrationBucket: sim.lastMigrationBucket,
    freightBucket: sim.lastFreightBucket,
    servicesBucket: sim.lastServicesBucket,
    emergencyBucket: sim.lastEmergencyBucket,
    settledDay: sim.lastSettledDay,
    money: {
      balance: sim.economy.balance,
      debt: sim.economy.debt,
      spent: sim.economy.spentOnBuilding,
      rates: { ...sim.economy.rates },
    },
    traffic: encodeBytes(new Uint8Array(sim.traffic.snapshot().buffer)),
    noise: encodeBytes(new Uint8Array(sim.noise.snapshot().buffer)),
    landValue: encodeBytes(new Uint8Array(sim.landValue.snapshot().buffer)),
    crime: encodeBytes(new Uint8Array(sim.crime.snapshot().buffer)),
    terrain: encodeBytes(world.map.terrain),
    road: encodeBytes(world.map.road),
    rail: encodeBytes(world.map.rail),
    zone: encodeBytes(world.map.zone),
    resource: encodeBytes(world.map.resource),
    buildings: world.buildings.map(saveBuilding),
    citizens: world.citizens.map(saveCitizen),
    lines: world.lines.map(saveLine),
    trains: world.trains.map(saveTrain),
    lorries: world.lorries.map(saveLorry),
    buses: world.buses.map(saveBus),
    units: world.units.map(saveUnit),
    // Incidents are events in flight rather than things on the map, so they
    // live with the simulation that runs them -- but they are just as
    // unrecoverable as a citizen's half-finished trip, and a load that
    // silently put a burning building out would be a load that lied.
    incidents: sim.emergency.snapshot(),
  };
}

function saveBuilding(b: Building): SavedBuilding {
  return {
    t: b.type,
    tile: b.tile,
    access: b.accessRoad,
    platform: b.platform,
    cap: b.capacity,
    occ: b.occupants.slice(),
    alive: b.alive,
    raw: b.rawStock,
    goods: b.goodsStock,
    sold: b.soldToday,
    starved: b.starvedHours,
  };
}

function saveCitizen(c: Citizen): SavedCitizen {
  const out: SavedCitizen = {
    seed: c.seed,
    name: c.name,
    age: c.age,
    home: c.home,
    work: c.work,
    state: c.state,
    mode: c.mode,
    dest: c.destination,
    s: c.s,
    v: c.v,
    x: c.x,
    y: c.y,
    trip: c.tripStartTick,
    retry: c.retryAtTick,
    origin: c.origin,
    leg: c.legState,
    pantry: c.pantry,
    shopFailed: c.lastShopFailed,
    nextShop: c.nextShopTick,
    blocked: c.blockedTicks,
    routing: c.awaitingPath,
    wait: c.waitStartTick,
    lastWait: c.lastWaitTicks,
    train: c.boardedVehicle,
    education: c.education,
    hasCar: c.hasCar,
    happy: c.happiness,
    unhappy: c.unhappyHours,
    lastTrip: c.lastTripTicks,
  };
  if (c.path) out.path = c.path.slice();
  if (c.legAfterRide) out.after = c.legAfterRide.slice();
  if (c.ride) out.ride = { ...c.ride };
  return out;
}

function saveLine(l: TransitLine): SavedLine {
  return {
    name: l.name,
    color: l.color,
    mode: l.mode,
    stations: l.stations.slice(),
    route: l.route.slice(),
    stopAt: l.stopAt.slice(),
    stopStation: l.stopStation.slice(),
    vehicles: l.vehicles.slice(),
    ridership: l.ridership,
  };
}

function saveBus(b: Bus): SavedBus {
  const out: SavedBus = {
    line: b.line,
    nextStop: b.nextStop,
    dwellUntil: b.dwellUntil,
    passengers: b.passengers.slice(),
    resume: b.resumeAtTick,
    s: b.s,
    v: b.v,
    x: b.x,
    y: b.y,
    blocked: b.blockedTicks,
  };
  if (b.path) out.path = b.path.slice();
  return out;
}

function saveUnit(u: EmergencyUnit): SavedUnit {
  const out: SavedUnit = {
    kind: u.kind,
    home: u.home,
    state: u.state,
    incident: u.incident,
    resume: u.resumeAtTick,
    lastResponse: u.lastResponseTicks,
    calls: u.calls,
    s: u.s,
    v: u.v,
    x: u.x,
    y: u.y,
    blocked: u.blockedTicks,
  };
  if (u.path) out.path = u.path.slice();
  return out;
}

function saveLorry(l: Lorry): SavedLorry {
  const out: SavedLorry = {
    state: l.state,
    home: l.home,
    dest: l.destination,
    cargo: l.cargo,
    cargoKind: l.cargoKind,
    resume: l.resumeAtTick,
    s: l.s,
    v: l.v,
    x: l.x,
    y: l.y,
    blocked: l.blockedTicks,
    trips: l.trips,
    tripStart: l.tripStartTick,
  };
  if (l.path) out.path = l.path.slice();
  if (l.pendingPath) out.pending = l.pendingPath.slice();
  return out;
}

function saveTrain(t: Train): SavedTrain {
  return {
    line: t.line,
    s: t.s,
    v: t.v,
    nextStop: t.nextStop,
    dwellUntil: t.dwellUntil,
    passengers: t.passengers.slice(),
  };
}

// --- Reading ---------------------------------------------------------------

/**
 * Rebuild a whole simulation from a save. A fresh `World` is constructed and
 * then overwritten wholesale rather than patched, so a load can never leave a
 * half-old city behind; the caller simply swaps to the returned simulation.
 */
export function deserialize(data: SaveData): Simulation {
  if (!data || typeof data !== 'object') throw new Error('セーブデータを読み取れません');
  if (data.version !== SAVE_VERSION) {
    throw new Error(`セーブデータの形式が違います (v${data.version})`);
  }

  const world = new World(1);
  const { map } = world;
  decodeBytes(data.terrain, map.terrain);
  decodeBytes(data.road, map.road);
  decodeBytes(data.rail, map.rail);
  decodeBytes(data.zone, map.zone);
  decodeBytes(data.resource, map.resource);
  map.building.fill(-1);
  world.roads.rebuildAll();
  world.rails.rebuildAll();

  world.buildings.length = 0;
  data.buildings.forEach((b, id) => {
    const building: Building = {
      id,
      type: b.t as BuildingType,
      tile: b.tile,
      accessRoad: b.access,
      platform: b.platform,
      capacity: b.cap,
      occupants: b.occ.slice(),
      alive: b.alive,
      // Recomputed by the power grid on the first slow tick after loading.
      powered: false,
      rawStock: b.raw,
      goodsStock: b.goods,
      soldToday: b.sold,
      starvedHours: b.starved,
    };
    world.buildings.push(building);
    if (building.alive) map.building[building.tile] = id;
  });

  world.citizens.length = 0;
  data.citizens.forEach((c, id) => {
    world.citizens.push({
      id,
      seed: c.seed,
      name: c.name,
      age: c.age,
      home: c.home,
      work: c.work,
      state: c.state as CitizenState,
      mode: c.mode as TravelMode,
      profile: CAR_PROFILE,
      path: c.path ?? null,
      origin: c.origin,
      destination: c.dest,
      legState: c.leg as CitizenState,
      s: c.s,
      v: c.v,
      x: c.x,
      y: c.y,
      prevX: c.x,
      prevY: c.y,
      blockedTicks: c.blocked ?? 0,
      signalHold: -1,
      tripStartTick: c.trip,
      awaitingPath: false,
      retryAtTick: c.retry,
      ride: c.ride ?? null,
      legAfterRide: c.after ?? null,
      boardedVehicle: c.train,
      waitStartTick: c.wait,
      lastWaitTicks: c.lastWait ?? 0,
      education: c.education,
      hasCar: c.hasCar,
      happiness: c.happy,
      unhappyHours: c.unhappy,
      lastTripTicks: c.lastTrip,
      pantry: c.pantry,
      lastShopFailed: c.shopFailed,
      nextShopTick: c.nextShop,
      left: false,
    });
  });

  world.lines.length = 0;
  data.lines.forEach((l, id) => {
    world.lines.push({
      id,
      name: l.name,
      color: l.color,
      mode: l.mode as LineMode,
      stations: l.stations.slice(),
      route: l.route.slice(),
      stopAt: l.stopAt.slice(),
      stopStation: l.stopStation.slice(),
      vehicles: l.vehicles.slice(),
      ridership: l.ridership,
    });
  });

  world.trains.length = 0;
  data.trains.forEach((t, id) => {
    const train: Train = {
      id,
      line: t.line,
      s: t.s,
      v: t.v,
      nextStop: t.nextStop,
      dwellUntil: t.dwellUntil,
      passengers: t.passengers.slice(),
      x: 0,
      y: 0,
      prevX: 0,
      prevY: 0,
    };
    world.trains.push(train);
    const line = world.lines[train.line];
    if (line && line.route.length > 0) {
      setTrainPosition(line, train);
      train.prevX = train.x;
      train.prevY = train.y;
    }
  });

  world.lorries.length = 0;
  data.lorries.forEach((l, index) => {
    const lorry = createLorry(index, l.home, 0);
    lorry.state = l.state as LorryState;
    lorry.destination = l.dest;
    lorry.cargo = l.cargo;
    lorry.cargoKind = l.cargoKind as CargoKind;
    lorry.resumeAtTick = l.resume;
    lorry.s = l.s;
    lorry.v = l.v;
    lorry.x = l.x;
    lorry.y = l.y;
    lorry.prevX = l.x;
    lorry.prevY = l.y;
    lorry.blockedTicks = l.blocked;
    lorry.trips = l.trips;
    lorry.tripStartTick = l.tripStart;
    lorry.path = l.path ?? null;
    lorry.pendingPath = l.pending ?? null;
    world.lorries.push(lorry);
  });

  world.buses.length = 0;
  data.buses.forEach((b, index) => {
    const bus = createBus(index, b.line, b.nextStop, 0);
    bus.dwellUntil = b.dwellUntil;
    bus.passengers = b.passengers.slice();
    bus.resumeAtTick = b.resume;
    bus.s = b.s;
    bus.v = b.v;
    bus.x = b.x;
    bus.y = b.y;
    bus.prevX = b.x;
    bus.prevY = b.y;
    bus.blockedTicks = b.blocked;
    bus.path = b.path ?? null;
    world.buses.push(bus);
  });

  world.units.length = 0;
  data.units.forEach((u, index) => {
    const unit = createUnit(index, u.kind as IncidentKind, u.home, 0);
    unit.state = u.state as UnitState;
    unit.incident = u.incident;
    unit.resumeAtTick = u.resume;
    unit.lastResponseTicks = u.lastResponse;
    unit.calls = u.calls;
    unit.s = u.s;
    unit.v = u.v;
    unit.x = u.x;
    unit.y = u.y;
    unit.prevX = u.x;
    unit.prevY = u.y;
    unit.blockedTicks = u.blocked;
    unit.path = u.path ?? null;
    world.units.push(unit);
  });

  world.rng.setState(data.rngState);
  world.nextCitizenSeed = data.citizenSeed;
  world.revision++;

  const sim = new Simulation(world);
  sim.clock.tick = data.tick;
  sim.lastGrowthBucket = data.growthBucket;
  sim.lastPowerBucket = data.powerBucket;
  sim.lastChainBucket = data.chainBucket;
  sim.lastFieldBucket = data.fieldBucket;
  sim.lastMigrationBucket = data.migrationBucket;
  sim.lastFreightBucket = data.freightBucket;
  sim.lastServicesBucket = data.servicesBucket ?? -1;
  sim.lastEmergencyBucket = data.emergencyBucket ?? -1;
  sim.lastSettledDay = data.settledDay;
  sim.economy.restore({
    balance: data.money.balance,
    debt: data.money.debt,
    rates: data.money.rates,
    spentOnBuilding: data.money.spent,
  });
  sim.stats.restore(data.completedTrips ?? 0);
  sim.stats.sample(world);

  sim.traffic.restore(decodeFloatField(data.traffic));
  sim.noise.restore(decodeFloatField(data.noise));
  sim.landValue.restore(decodeFloatField(data.landValue));
  sim.crime.restore(decodeFloatField(data.crime));
  sim.emergency.restore(data.incidents ?? []);
  // Power is not saved: it is a pure function of the city, and the first slow
  // tick after loading recomputes it before anything can read it. Civic
  // coverage is the same kind of thing and is recomputed here for the same
  // reason -- a panel opened before the first slow tick would otherwise say
  // the schools reach nobody.
  sim.power.update(world);
  sim.services.update(world);

  // Anyone whose routing request was still queued when the save was taken
  // needs it re-issued: the queue itself belongs to the old simulation.
  data.citizens.forEach((c, id) => {
    if (c.routing) sim.requestRoute(world.citizens[id]);
  });

  return sim;
}

// --- Byte layers -----------------------------------------------------------
// Base64 rather than a JSON array of 16384 numbers: the same data at roughly a
// fifth of the size, which is what keeps a saved city inside the localStorage
// quota.

const CHUNK = 8192;

export function encodeBytes(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

export function decodeBytes(encoded: string, into: Uint8Array): void {
  if (into.length !== MAP_SIZE * MAP_SIZE) {
    throw new Error('マップの大きさがセーブデータと一致しません');
  }
  decodeFloats(encoded, into);
}

function decodeFloatField(encoded: string): Float32Array {
  const bytes = new Uint8Array(MAP_SIZE * MAP_SIZE * 4);
  decodeFloats(encoded, bytes);
  return new Float32Array(bytes.buffer);
}

/** The same decode without the map-size check, for the float layers. */
function decodeFloats(encoded: string, into: Uint8Array): void {
  const raw = atob(encoded);
  const n = Math.min(raw.length, into.length);
  for (let i = 0; i < n; i++) into[i] = raw.charCodeAt(i);
}

// --- Browser storage -------------------------------------------------------

export function hasSavedCity(): boolean {
  try {
    return localStorage.getItem(SAVE_KEY) !== null;
  } catch {
    return false;
  }
}

/** Write the city to localStorage. Throws with a readable message on failure. */
export function saveToStorage(sim: Simulation): void {
  const json = JSON.stringify(serialize(sim));
  try {
    localStorage.setItem(SAVE_KEY, json);
  } catch {
    throw new Error('保存できません（ブラウザの保存容量が不足しています）');
  }
}

/** Read the city back, or null when nothing has been saved yet. */
export function loadFromStorage(): Simulation | null {
  let json: string | null = null;
  try {
    json = localStorage.getItem(SAVE_KEY);
  } catch {
    throw new Error('読み込めません（ブラウザの保存領域を利用できません）');
  }
  if (json === null) return null;
  return deserialize(JSON.parse(json) as SaveData);
}
