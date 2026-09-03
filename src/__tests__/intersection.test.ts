import { describe, expect, it } from 'vitest';
import { GIVE_WAY_NOSE_IN } from '../config';
import { idx } from '../core/grid';
import { Direction, Terrain, TravelMode, type TileIndex } from '../core/types';
import { CAR_PROFILE, LORRY_PROFILE, type FollowingProfile } from '../sim/carFollowing';
import { Crossings } from '../sim/crossings';
import { Occupancy } from '../sim/occupancy';
import { Signals } from '../sim/signals';
import { advanceVehicle, registerVehicle } from '../sim/movement';
import { tileCenterX, tileCenterY } from '../sim/citizen';
import type { RoadAgent } from '../sim/vehicle';
import { World } from '../world/world';

/**
 * A crossroads and nothing else: one street east/west, one north/south.
 *
 * The junction is deliberately left unsignalised (the test never calls
 * `Signals.refresh`), because what is being measured here is give-way
 * behaviour on its own -- a red light would stop the vehicle for reasons that
 * have nothing to do with the traffic crossing in front of it.
 */
const JUNCTION = idx(10, 10);

function crossroads(): World {
  const world = new World(7);
  world.map.terrain.fill(Terrain.Grass);
  for (let x = 5; x <= 15; x++) world.placeRoad(idx(x, 10));
  for (let y = 5; y <= 15; y++) world.placeRoad(idx(10, y));
  return world;
}

/** A vehicle starting at (5, 10) and driving east along the street. */
function eastbound(profile: FollowingProfile): RoadAgent {
  const path: TileIndex[] = [];
  for (let x = 5; x <= 15; x++) path.push(idx(x, 10));
  return {
    id: 1,
    mode: TravelMode.Car,
    profile,
    path,
    s: 0,
    v: profile.freeSpeed,
    x: tileCenterX(path[0]),
    y: tileCenterY(path[0]),
    prevX: tileCenterX(path[0]),
    prevY: tileCenterY(path[0]),
    blockedTicks: 0,
    signalHold: -1,
  };
}

/** Something driving north through the junction, for our driver to yield to. */
function crossingCar(progress: number) {
  return { id: 99, dir: Direction.North, progress, speedRatio: 0.5, size: 1 };
}

/**
 * Drive one vehicle east through the junction, with north/south traffic
 * occupying the box on the cadence `busy` describes, and report how long it
 * took to get its nose across.
 */
function ticksToClearJunction(
  agent: RoadAgent,
  busy: (tick: number) => boolean,
  limit: number,
): number {
  const world = crossroads();
  const occ = new Occupancy();
  const crossings = new Crossings();
  const signals = new Signals();
  // Index of the junction on the route: `s` past this means we are through.
  const junctionIndex = agent.path!.indexOf(JUNCTION);

  for (let tick = 1; tick <= limit; tick++) {
    occ.clear();
    if (busy(tick)) occ.add(JUNCTION, crossingCar(0.5));
    registerVehicle(world, occ, agent);
    advanceVehicle(world, agent, occ, crossings, signals, tick);
    if (agent.s > junctionIndex) return tick;
  }
  return Infinity;
}

describe('giving way at a junction', () => {
  it('gets a lorry through a junction that is never clear, not just a car', () => {
    // The regression this file exists for. Giving way used to be expressed as
    // a gap to a leader half a tile inside the junction, and a car (a quarter
    // of a tile long) still had room to creep into that gap while a lorry
    // (nearly half a tile) did not -- so the lorry crawled a millionth of a
    // tile per tick, never moved, and was never still enough to be released.
    const car = ticksToClearJunction(eastbound(CAR_PROFILE), () => true, 4000);
    const lorry = ticksToClearJunction(eastbound(LORRY_PROFILE), () => true, 4000);

    expect(car).toBeLessThan(200);
    expect(lorry).toBeLessThan(200);
  });

  it('eases up to a junction in use rather than driving into it', () => {
    const agent = eastbound(LORRY_PROFILE);
    const junctionIndex = agent.path!.indexOf(JUNCTION);
    const free = LORRY_PROFILE.freeSpeed;

    // Watch the approach: by the time it reaches the junction the vehicle
    // must have shed most of its speed, whatever its length.
    const world = crossroads();
    const occ = new Occupancy();
    const crossings = new Crossings();
    const signals = new Signals();
    let atTheMouth = free;
    for (let tick = 1; tick <= 200; tick++) {
      occ.clear();
      occ.add(JUNCTION, crossingCar(0.5));
      registerVehicle(world, occ, agent);
      advanceVehicle(world, agent, occ, crossings, signals, tick);
      if (agent.s > junctionIndex) break;
      atTheMouth = agent.v;
    }

    expect(atTheMouth).toBeLessThan(free * 0.4);
    // ...and it stops with its nose at the mouth of the junction rather than
    // in the middle of it, which is what keeps the box usable for the traffic
    // it was giving way to.
    expect(agent.s).toBeLessThan(junctionIndex + GIVE_WAY_NOSE_IN + 0.05);
  });

  it('keeps its release once it has one, so it clears in a single go', () => {
    // Crossing traffic in the box for 30 ticks out of every 40: gaps too
    // short for a lorry to pull away and cross a whole tile in one of them.
    const busy = (tick: number): boolean => tick % 40 < 30;
    const lorry = ticksToClearJunction(eastbound(LORRY_PROFILE), busy, 4000);

    expect(lorry).toBeLessThan(200);
  });
});

describe('occupancy: crossing traffic', () => {
  it('reports traffic across our path, but not with or against it', () => {
    const occ = new Occupancy();
    occ.add(JUNCTION, crossingCar(0.5));

    expect(occ.crossingTraffic(JUNCTION, Direction.East)).toBe(true);
    expect(occ.crossingTraffic(JUNCTION, Direction.North)).toBe(false);
    expect(occ.crossingTraffic(JUNCTION, Direction.South)).toBe(false);
  });

  it('does not treat crossing traffic as a car to follow', () => {
    const occ = new Occupancy();
    occ.add(JUNCTION, crossingCar(0.5));
    // A vehicle across the box is a reason to stop at the line, which is a
    // separate question from how far away the queue ahead of us starts.
    expect(occ.gapIntoTile(JUNCTION, Direction.East)).toBe(Infinity);
  });
});
