import { LORRY_PROFILE } from './carFollowing';
import { TravelMode, type BuildingId, type TileIndex } from '../core/types';
import { tileCenterX, tileCenterY } from './citizen';
import type { RoadAgent } from './vehicle';

/**
 * Ids for lorries start here, so that a lorry and a citizen can never look
 * like the same road user to the occupancy model.
 *
 * The occupancy snapshot is rebuilt every tick and only ever compares ids for
 * equality, so all this has to guarantee is that no citizen index reaches it --
 * and MAX_POPULATION is 2000.
 */
export const LORRY_ID_BASE = 1_000_000;

export const enum CargoKind {
  /** Ore, timber, fish, rice: whatever a factory turns into something else. */
  Raw = 0,
  /** Finished goods, on their way to a shop. */
  Goods = 1,
}

export const enum LorryState {
  /** Parked at its depot with nothing to do. Its slot can be reused. */
  Idle = 0,
  Loading = 1,
  /** Driving to the consumer, laden. */
  Outbound = 2,
  Unloading = 3,
  /** Driving back to the depot, empty. */
  Returning = 4,
  /** Nowhere to go: the road was cut. Waits and retries, like a stranded citizen. */
  Stuck = 5,
}

export interface Lorry extends RoadAgent {
  state: LorryState;
  /** The supplier it belongs to and returns to, or -1 once retired. */
  home: BuildingId;
  /** The consumer being served, or -1. */
  destination: BuildingId;
  cargo: number;
  cargoKind: CargoKind;
  /**
   * The tick this lorry may act again: leave a dock, or retry a route it could
   * not find. One field because it is always the same question -- wake me at T.
   */
  resumeAtTick: number;
  /**
   * The route to drive once loading finishes. Held back rather than driven
   * immediately so a lorry occupies its dock, not the road, while it loads.
   */
  pendingPath: TileIndex[] | null;
  awaitingPath: boolean;
  /** Deliveries completed, for the inspector. */
  trips: number;
  /** Tick the current delivery started, for the average-delivery-time figure. */
  tripStartTick: number;
}

/**
 * A lorry at rest in its depot's yard.
 *
 * Lorries are created and retired constantly, so the array they live in is
 * never compacted: a retired lorry becomes Idle with no depot and its slot is
 * handed to the next one. That is a deliberate contrast with citizens, whose
 * ids *are* renumbered when somebody leaves -- and the reason it is safe here
 * is the rule that freight never holds a citizen id. It holds building ids,
 * which are tombstoned rather than renumbered.
 */
export function createLorry(index: number, home: BuildingId, tile: TileIndex): Lorry {
  return {
    id: LORRY_ID_BASE + index,
    mode: TravelMode.Car,
    profile: LORRY_PROFILE,
    path: null,
    s: 0,
    v: 0,
    x: tileCenterX(tile),
    y: tileCenterY(tile),
    prevX: tileCenterX(tile),
    prevY: tileCenterY(tile),
    blockedTicks: 0,
    signalHold: -1,

    state: LorryState.Idle,
    home,
    destination: -1,
    cargo: 0,
    cargoKind: CargoKind.Goods,
    resumeAtTick: 0,
    pendingPath: null,
    awaitingPath: false,
    trips: 0,
    tripStartTick: 0,
  };
}

/** True while the lorry is out on the road rather than sitting in a yard. */
export function isDriving(lorry: Lorry): boolean {
  return lorry.state === LorryState.Outbound || lorry.state === LorryState.Returning;
}

/** A retired slot: no depot, no cargo, available for the next delivery. */
export function isSpare(lorry: Lorry): boolean {
  return lorry.state === LorryState.Idle && lorry.cargo === 0;
}
