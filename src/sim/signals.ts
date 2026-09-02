import {
  MAP_SIZE,
  SIGNAL_ALL_RED_TICKS,
  SIGNAL_CYCLE_TICKS,
  SIGNAL_GREEN_TICKS,
} from '../config';
import { tileX, tileY } from '../core/grid';
import { Direction, type TileIndex } from '../core/types';
import type { World } from '../world/world';

/** Which pair of approaches a phase is serving. */
export const enum SignalAxis {
  /** North <-> South. */
  NorthSouth = 0,
  /** East <-> West. */
  EastWest = 1,
  /** Between phases: every approach is held. */
  AllRed = -1,
}

/** The axis a car heading `dir` belongs to. */
export function axisOf(dir: Direction): SignalAxis {
  return dir === Direction.North || dir === Direction.South
    ? SignalAxis.NorthSouth
    : SignalAxis.EastWest;
}

/**
 * Traffic signals at junctions.
 *
 * A signal is not stored state: it is a pure function of the tick and a
 * per-junction offset, so it costs nothing to run, replays identically from a
 * seed, and survives save/load without being written to the file. The only
 * thing that is cached is *which* tiles are signalised, and that is rebuilt
 * from the road network whenever the player changes it.
 *
 * A junction earns a signal when two axes actually conflict there: it needs a
 * north/south connection, an east/west connection, and at least three arms.
 * A plain corner has nothing to arbitrate, and putting a red light on one
 * would only stop traffic for no reason.
 */
export class Signals {
  private readonly signalized = new Uint8Array(MAP_SIZE * MAP_SIZE);
  private readonly offsets = new Int32Array(MAP_SIZE * MAP_SIZE);
  private junctions: TileIndex[] = [];
  private version = -1;

  /** Rebuild the junction list if the road network changed since last tick. */
  refresh(world: World): void {
    if (world.roads.version === this.version) return;
    this.version = world.roads.version;
    this.signalized.fill(0);
    this.junctions.length = 0;

    const adjacency = world.roads.adjacency;
    for (let tile = 0; tile < adjacency.length; tile++) {
      const mask = adjacency[tile];
      if (mask === 0) continue;
      const ns = (mask & 0b0001) !== 0 || (mask & 0b0100) !== 0;
      const ew = (mask & 0b0010) !== 0 || (mask & 0b1000) !== 0;
      if (!ns || !ew) continue;
      if (armCount(mask) < 3) continue;

      this.signalized[tile] = 1;
      this.offsets[tile] = offsetFor(tile);
      this.junctions.push(tile);
    }
  }

  isSignalized(tile: TileIndex): boolean {
    return tile >= 0 && this.signalized[tile] === 1;
  }

  /** The axis currently getting green at this junction. */
  greenAxis(tile: TileIndex, tick: number): SignalAxis {
    if (!this.isSignalized(tile)) return SignalAxis.AllRed;
    const phase = (tick + this.offsets[tile]) % SIGNAL_CYCLE_TICKS;
    if (phase < SIGNAL_GREEN_TICKS) return SignalAxis.NorthSouth;
    if (phase < SIGNAL_GREEN_TICKS + SIGNAL_ALL_RED_TICKS) return SignalAxis.AllRed;
    if (phase < 2 * SIGNAL_GREEN_TICKS + SIGNAL_ALL_RED_TICKS) return SignalAxis.EastWest;
    return SignalAxis.AllRed;
  }

  /** True when a car heading `dir` must hold at the stop line of `tile`. */
  isRed(tile: TileIndex, dir: Direction, tick: number): boolean {
    if (!this.isSignalized(tile)) return false;
    return this.greenAxis(tile, tick) !== axisOf(dir);
  }

  get signalTiles(): readonly TileIndex[] {
    return this.junctions;
  }
}

function armCount(mask: number): number {
  let n = 0;
  for (let dir = 0; dir < 4; dir++) {
    if ((mask & (1 << dir)) !== 0) n++;
  }
  return n;
}

/**
 * Junctions are offset by position rather than at random, which gives a
 * street of signals a rolling progression instead of every light on the map
 * turning green at once.
 */
function offsetFor(tile: TileIndex): number {
  return (tileX(tile) * 7 + tileY(tile) * 13) % SIGNAL_CYCLE_TICKS;
}
