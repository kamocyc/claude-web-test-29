import { BUS_PROFILE } from './carFollowing';
import { TravelMode, type CitizenId, type LineId, type TileIndex } from '../core/types';
import { tileCenterX, tileCenterY } from './citizen';
import type { RoadAgent } from './vehicle';

/**
 * Ids for buses start here, above the citizens and the lorries, so that no two
 * road users can ever look like the same vehicle to the occupancy model.
 */
export const BUS_ID_BASE = 3_000_000;

/**
 * A bus: a road vehicle that happens to be running a transit line.
 *
 * This is the whole reason buses are worth having in this simulation. A train
 * has its own right of way and a stored route it can never be knocked off; a
 * bus is a `RoadAgent` like a car or a lorry, so it queues at the same lights,
 * waits at the same level crossing and crawls through the same jam the
 * player's road layout produced. A bus route that is quicker than driving is
 * one the player has actually earned.
 *
 * It carries passengers exactly as a train does (see `boarding.ts`), so a
 * rider never needs to know which of the two they are sitting on.
 */
export interface Bus extends RoadAgent {
  /** The line being worked, or -1 once the route has been withdrawn. */
  line: LineId;
  /** Index into `line.stopAt` of the stop being driven to. */
  nextStop: number;
  /** Tick this bus may pull away from the kerb. 0 when not at a stop. */
  dwellUntil: number;
  passengers: CitizenId[];
  /** Tick a bus with nowhere to drive may look for a route again. */
  resumeAtTick: number;
  awaitingPath: boolean;
}

export function createBus(index: number, line: LineId, stop: number, tile: TileIndex): Bus {
  return {
    id: BUS_ID_BASE + index,
    mode: TravelMode.Car,
    profile: BUS_PROFILE,
    path: null,
    s: 0,
    v: 0,
    x: tileCenterX(tile),
    y: tileCenterY(tile),
    prevX: tileCenterX(tile),
    prevY: tileCenterY(tile),
    blockedTicks: 0,
    signalHold: -1,

    line,
    nextStop: stop,
    dwellUntil: 0,
    passengers: [],
    resumeAtTick: 0,
    awaitingPath: false,
  };
}
