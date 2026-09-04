import type { NetworkState } from '../track/network/network';
import type { TransitLine, LineId } from '../track/network/line';
import type { ZoneType } from '../track/network/zoning';
import type { CitySimulation, SimSave } from './simulation';
import type { CityWorld } from './world';

/**
 * Saving the city.
 *
 * What is written down is only what could not be worked out again: the seed
 * the ground came from, the network as it stands, what has been painted on it,
 * and the city living on top. Everything else -- the terrain heights, the
 * plots, the lane graph, the line routes, the traffic -- is derived, and
 * deriving it again on load is both shorter and safer than storing a copy that
 * could disagree with the network it came from.
 *
 * The network is written as its raw state rather than as the sequence of
 * commands that produced it. Replaying the commands would renumber everything,
 * and the numbers are load-bearing: a building remembers the segment it is
 * entered from, and a line remembers the stations it calls at.
 */

export const SAVE_VERSION = 1;
export const SAVE_KEY = 'claude-city-alignment';

export interface CitySave {
  version: number;
  /** When it was written, for the load menu. */
  savedAt: number;
  /** The terrain seed. The ground is regenerated, never stored. */
  seed: number;
  network: NetworkState;
  zones: Array<[number, ZoneType]>;
  lines: { nextId: LineId; lines: TransitLine[] };
  city: SimSave;
}

/** Everything needed to bring this city back, as plain data. */
export function captureCity(world: CityWorld, sim: CitySimulation): CitySave {
  return {
    version: SAVE_VERSION,
    savedAt: Date.now(),
    seed: world.seed,
    network: world.net.toState(),
    zones: world.zones.toState(),
    lines: world.lines.toState(),
    city: sim.capture(),
  };
}

/**
 * Put a saved city back.
 *
 * The world has to be the one the save came from -- same seed, so the same
 * ground -- which is why loading a save is done by building a world for its
 * seed rather than by pouring a save into whatever world is on screen.
 */
export function applyCity(world: CityWorld, sim: CitySimulation, save: CitySave): void {
  if (save.version !== SAVE_VERSION) {
    throw new Error(`このセーブは形式 ${save.version} です (対応: ${SAVE_VERSION})`);
  }
  if (save.seed !== world.seed) {
    throw new Error('セーブの地形と世界が違います');
  }
  world.net.restore(save.network);
  world.zones.restore(save.zones);
  world.lines.restore(save.lines);
  // Everything derived comes back here: plots, the lane graph, the line
  // routes, and the buildings the renderer draws.
  world.rebuild();
  sim.adopt(save.city);
}

/** True when the browser is holding a save. */
export function hasSave(storage: Storage = localStorage): boolean {
  try {
    return storage.getItem(SAVE_KEY) !== null;
  } catch {
    return false;
  }
}

export function writeSave(save: CitySave, storage: Storage = localStorage): void {
  storage.setItem(SAVE_KEY, JSON.stringify(save));
}

/** The stored save, or null when there is none or it cannot be read. */
export function readSave(storage: Storage = localStorage): CitySave | null {
  let text: string | null = null;
  try {
    text = storage.getItem(SAVE_KEY);
  } catch {
    return null;
  }
  if (!text) return null;
  try {
    const save = JSON.parse(text) as CitySave;
    // A save from an older build is not half-loaded: it is refused, and the
    // city that is already running is left alone.
    return save.version === SAVE_VERSION ? save : null;
  } catch {
    return null;
  }
}

export function clearSave(storage: Storage = localStorage): void {
  try {
    storage.removeItem(SAVE_KEY);
  } catch {
    // Nothing to do: a save that cannot be removed is a save that was never
    // written.
  }
}
