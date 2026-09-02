import { CAR_LENGTH, CAR_MIN_GAP } from '../config';
import type { TileIndex, TravelMode } from '../core/types';
import type { FollowingProfile } from './carFollowing';

/**
 * Everything that moves along a road under its own power.
 *
 * Citizens and lorries share one movement model rather than having two that
 * drift apart: the same car-following, the same tile occupancy, the same
 * signals and level crossings. This interface is exactly the set of fields
 * `movement.ts` touches, and no more -- a lorry knows nothing about
 * happiness, and a citizen knows nothing about cargo.
 *
 * Trains are deliberately *not* road agents. They run a stored round trip that
 * wraps, with dwells instead of destinations, so `trains.ts` keeps its own
 * loop; what they share with everything else is the car-following model
 * itself, which is a pure function.
 */
export interface RoadAgent {
  /**
   * An identity, only ever compared for equality -- occupancy uses it to
   * exclude a vehicle from its own leader search. It has to be unique among
   * the agents alive in one tick and nothing more, which is why lorries can
   * take ids from a separate range rather than being renumbered.
   */
  id: number;
  /** Walk moves as a pedestrian; Car (and everything a lorry does) drives. */
  mode: TravelMode;
  /** Door-to-door route: [originTile, ...roads, destinationTile]. */
  path: TileIndex[] | null;
  /** Distance travelled along `path`, in tiles. Integer part = segment index. */
  s: number;
  /** Current speed in tiles/tick, carried across ticks so acceleration exists. */
  v: number;

  x: number;
  y: number;
  prevX: number;
  prevY: number;

  /** Ticks spent unable to move; releases the soft tile capacity on gridlock. */
  blockedTicks: number;
  /** The junction this vehicle has decided to stop at, or -1. */
  signalHold: TileIndex;
  /** Free speed, acceleration and size. What makes a lorry not a car. */
  profile: FollowingProfile;
}

/**
 * How much of a tile a vehicle takes up, as a multiple of a car.
 *
 * Used for the soft tile capacity and for traffic noise, so a lorry counts as
 * the two-and-a-bit cars it physically is in both places rather than as one
 * more "vehicle". Deriving it from the profile means the two can never
 * disagree with the gap the following model actually leaves.
 */
export function occupantSize(profile: FollowingProfile): number {
  return (profile.length + profile.minGap) / (CAR_LENGTH + CAR_MIN_GAP);
}
