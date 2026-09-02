import { MAP_SIZE } from '../config';
import type { CitizenState, TravelMode, BuildingType, TileIndex } from '../core/types';
import type { Citizen } from '../sim/citizen';
import { Simulation } from '../sim/simulation';
import { setTrainPosition } from '../sim/trains';
import type { RideLeg } from '../sim/transitPlanner';
import type { Building } from './buildings';
import type { TransitLine, Train } from './transit';
import { World } from './world';

export const SAVE_VERSION = 2;
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
  /** The growth bucket already evaluated, so a load does not re-run growth. */
  growthBucket: number;
  /** Base64 of the remembered per-tile speed ratios (Float32, MAP_SIZE^2). */
  traffic: string;
  /** Base64 of the four byte layers, each MAP_SIZE^2 long. */
  terrain: string;
  road: string;
  rail: string;
  zone: string;
  buildings: SavedBuilding[];
  citizens: SavedCitizen[];
  lines: SavedLine[];
  trains: SavedTrain[];
}

interface SavedBuilding {
  t: number;
  tile: TileIndex;
  access: TileIndex;
  platform: TileIndex;
  cap: number;
  occ: number[];
  alive: boolean;
}

interface SavedCitizen {
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
  blocked: number;
  routing: boolean;
  wait: number;
  lastWait: number;
  train: number;
  path?: TileIndex[];
  after?: TileIndex[];
  ride?: RideLeg;
}

interface SavedLine {
  name: string;
  color: string;
  stations: number[];
  route: TileIndex[];
  stopAt: number[];
  stopStation: number[];
  trains: number[];
  ridership: number;
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
    growthBucket: sim.lastGrowthBucket,
    traffic: encodeBytes(new Uint8Array(sim.traffic.snapshot().buffer)),
    terrain: encodeBytes(world.map.terrain),
    road: encodeBytes(world.map.road),
    rail: encodeBytes(world.map.rail),
    zone: encodeBytes(world.map.zone),
    buildings: world.buildings.map(saveBuilding),
    citizens: world.citizens.map(saveCitizen),
    lines: world.lines.map(saveLine),
    trains: world.trains.map(saveTrain),
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
  };
}

function saveCitizen(c: Citizen): SavedCitizen {
  const out: SavedCitizen = {
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
    blocked: c.blockedTicks,
    routing: c.awaitingPath,
    wait: c.waitStartTick,
    lastWait: c.lastWaitTicks,
    train: c.boardedTrain,
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
    stations: l.stations.slice(),
    route: l.route.slice(),
    stopAt: l.stopAt.slice(),
    stopStation: l.stopStation.slice(),
    trains: l.trains.slice(),
    ridership: l.ridership,
  };
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
    };
    world.buildings.push(building);
    if (building.alive) map.building[building.tile] = id;
  });

  world.citizens.length = 0;
  data.citizens.forEach((c, id) => {
    world.citizens.push({
      id,
      name: c.name,
      age: c.age,
      home: c.home,
      work: c.work,
      state: c.state as CitizenState,
      mode: c.mode as TravelMode,
      path: c.path ?? null,
      destination: c.dest,
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
      boardedTrain: c.train,
      waitStartTick: c.wait,
      lastWaitTicks: c.lastWait ?? 0,
    });
  });

  world.lines.length = 0;
  data.lines.forEach((l, id) => {
    world.lines.push({
      id,
      name: l.name,
      color: l.color,
      stations: l.stations.slice(),
      route: l.route.slice(),
      stopAt: l.stopAt.slice(),
      stopStation: l.stopStation.slice(),
      trains: l.trains.slice(),
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

  world.rng.setState(data.rngState);
  world.revision++;

  const sim = new Simulation(world);
  sim.clock.tick = data.tick;
  sim.lastGrowthBucket = data.growthBucket ?? -1;
  sim.stats.restore(data.completedTrips ?? 0);
  sim.stats.sample(world);

  if (data.traffic) {
    const bytes = new Uint8Array(MAP_SIZE * MAP_SIZE * 4);
    decodeFloats(data.traffic, bytes);
    sim.traffic.restore(new Float32Array(bytes.buffer));
  }

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

/** The same decode without the map-size check, for the float layer. */
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
