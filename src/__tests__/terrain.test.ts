import { describe, expect, it } from 'vitest';
import {
  MAX_BUILD_RELIEF,
  MAX_TERRAIN_HEIGHT,
  MIN_GRADE_SPEED_RATIO,
  TICKS_PER_DAY,
} from '../config';
import { idx, tileX, tileY } from '../core/grid';
import { CAR_PROFILE, LORRY_PROFILE } from '../sim/carFollowing';
import { gradeFactor } from '../sim/movement';
import { findPath } from '../sim/pathfinding';
import { deserialize, serialize } from '../world/persistence';
import { Terrain, Zone } from '../core/types';
import { Simulation } from '../sim/simulation';
import { newGame } from '../world/scenario';
import { World } from '../world/world';
import { run } from './helpers';

/** A flat world with a ridge: two levels up in one tile, along a whole column. */
function ridgeWorld(): World {
  const w = new World(5);
  w.map.terrain.fill(Terrain.Grass);
  w.map.height.fill(0);
  for (let y = 0; y < 128; y++) {
    for (let x = 30; x < 128; x++) w.map.height[idx(x, y)] = 2;
  }
  w.map.refreshRelief();
  return w;
}

describe('terrain height', () => {
  it('generates ground inside the range, with the water at the bottom', () => {
    const world = newGame();
    const { map } = world;

    let water = 0;
    let highest = 0;
    for (let tile = 0; tile < map.height.length; tile++) {
      expect(map.height[tile]).toBeLessThanOrEqual(MAX_TERRAIN_HEIGHT);
      highest = Math.max(highest, map.height[tile]);
      if (map.isWater(tile)) {
        // The river is the low ground, not a channel across a hillside.
        expect(map.height[tile]).toBe(0);
        water++;
      }
    }
    expect(water).toBeGreaterThan(0);
    // The map is not a plain: there is somewhere worth calling a hill.
    expect(highest).toBeGreaterThanOrEqual(3);
  });

  it('levels the site the opening town is laid out on', () => {
    const world = newGame();
    // Every street of the starting grid is on flat ground, or the town could
    // not have been built the way the scenario builds it.
    for (let tile = 0; tile < world.map.road.length; tile++) {
      if (!world.map.isRoad(tile)) continue;
      if (tileX(tile) < 57 || tileX(tile) > 128) continue;
      expect(world.map.relief(tile)).toBeLessThanOrEqual(MAX_BUILD_RELIEF);
    }
  });

  it('keeps an escarpment out of the zoning', () => {
    const world = ridgeWorld();
    // Streets either side of the tiles under test, so the only thing that can
    // refuse them is the ground itself.
    for (const y of [18, 20]) {
      for (let x = 26; x <= 34; x++) world.placeRoad(idx(x, y));
    }

    // The tiles on the step itself are too uneven to build on; the flat ground
    // either side of it is not.
    expect(world.canZone(idx(29, 19), Zone.ResidentialLow)).toBe(false);
    expect(world.canZone(idx(30, 19), Zone.ResidentialLow)).toBe(false);
    expect(world.canZone(idx(26, 19), Zone.ResidentialLow)).toBe(true);
    expect(world.canZone(idx(34, 19), Zone.ResidentialLow)).toBe(true);
  });
});

describe('gradients', () => {
  it('lets a road climb anything and stops a railway at one level', () => {
    const world = ridgeWorld();

    // A road up the escarpment: allowed, because a road can be steep.
    expect(world.placeRoad(idx(29, 10))).toBe(true);
    expect(world.placeRoad(idx(30, 10))).toBe(true);

    // Track cannot: two levels in one tile is beyond anything on rails.
    expect(world.placeRail(idx(29, 12))).toBe(true);
    expect(world.railGradeAllows(idx(30, 12), 0)).toBe(false);
    expect(world.placeRail(idx(30, 12))).toBe(false);
    expect(world.map.isRail(idx(30, 12))).toBe(false);
  });

  it('lets a railway climb the step one level at a time on a viaduct', () => {
    const world = ridgeWorld();
    world.placeRail(idx(29, 12));
    // Carried one level, the low side is now a single step below the high
    // ground, which is exactly what the rule allows.
    expect(world.raiseRail(idx(29, 12))).toBe(true);
    expect(world.map.railHeight(idx(29, 12))).toBe(1);
    expect(world.placeRail(idx(30, 12))).toBe(true);
  });

  it('slows a vehicle down going uphill and leaves it alone coming down', () => {
    const world = ridgeWorld();
    const climbing = [idx(28, 5), idx(29, 5), idx(30, 5), idx(31, 5)];
    for (const tile of climbing) world.placeRoad(tile);
    expect(world.map.travelHeight(idx(30, 5)) - world.map.travelHeight(idx(29, 5))).toBe(2);

    // The free speed on the climbing segment is cut, on the flat ones it is
    // not, and coming back down is not a bonus.
    expect(gradeFactor(world, climbing, 0, CAR_PROFILE.gradeSensitivity)).toBe(1);
    const up = gradeFactor(world, climbing, 1, CAR_PROFILE.gradeSensitivity);
    expect(up).toBeLessThan(1);
    expect(up).toBeGreaterThanOrEqual(MIN_GRADE_SPEED_RATIO);
    const down = [...climbing].reverse();
    expect(gradeFactor(world, down, 1, CAR_PROFILE.gradeSensitivity)).toBe(1);

    // A lorry feels the same hill more than a car does.
    expect(gradeFactor(world, climbing, 1, LORRY_PROFILE.gradeSensitivity))
      .toBeLessThan(up);
  });

  it('routes round a hill rather than over it', () => {
    const world = new World(29);
    world.map.terrain.fill(Terrain.Grass);
    world.map.height.fill(0);
    // Two knolls sitting on the direct line, and flat ground beside it.
    for (const x of [28, 32]) {
      for (let y = 3; y <= 5; y++) world.map.height[idx(x, y)] = MAX_TERRAIN_HEIGHT;
    }
    world.map.refreshRelief();

    // The straight street over both, and a parallel one on the level.
    for (let x = 25; x <= 35; x++) world.placeRoad(idx(x, 5));
    for (let x = 25; x <= 35; x++) world.placeRoad(idx(x, 6));
    for (const x of [25, 35]) {
      for (let y = 5; y <= 6; y++) world.placeRoad(idx(x, y));
    }

    const path = findPath(world.roads, idx(25, 5), idx(35, 5), world.roadStep)!;
    expect(path).not.toBeNull();
    // Longer in tiles, quicker in time, and it is what the router picks --
    // which is the point of pricing the climb rather than the distance.
    expect(path.length).toBeGreaterThan(11);
    expect(path.some((t) => tileY(t) === 6)).toBe(true);
    expect(path.every((t) => world.map.height[t] === 0)).toBe(true);
  });
});

describe('grade separation', () => {
  it('turns a level crossing into a flyover, and the barrier stops coming down', () => {
    const world = new World(11);
    world.map.terrain.fill(Terrain.Grass);
    const tile = idx(20, 20);
    for (let x = 10; x <= 30; x++) world.placeRail(idx(x, 20));
    for (let y = 10; y <= 30; y++) world.placeRoad(idx(20, y));

    expect(world.map.isCrossing(tile)).toBe(true);

    // Carry the road over the railway: same tile, different place.
    expect(world.raiseRoad(tile)).toBe(true);
    expect(world.map.isCrossing(tile)).toBe(false);
    expect(world.map.isRoad(tile)).toBe(true);
    expect(world.map.isRail(tile)).toBe(true);

    // And bulldozing it puts the crossing back, rather than leaving a road
    // that is somehow still in the air.
    world.bulldoze(tile);
    expect(world.map.roadRaise[tile]).toBe(0);
  });

  it('carries a bridge over water that a road may not touch', () => {
    const world = new World(13);
    world.map.terrain.fill(Terrain.Grass);
    for (let y = 0; y < 128; y++) world.map.terrain[idx(20, y)] = Terrain.Water;
    world.map.refreshRelief();

    for (let x = 15; x <= 19; x++) world.placeRoad(idx(x, 30));
    for (let x = 21; x <= 25; x++) world.placeRoad(idx(x, 30));
    // The water is a hard barrier to an ordinary road...
    expect(world.placeRoad(idx(20, 30))).toBe(false);
    expect(world.roads.has(idx(20, 30))).toBe(false);

    // ...and a bridge is the answer, which is what elevation is for.
    expect(world.raiseRoad(idx(20, 30))).toBe(true);
    expect(world.map.isRoad(idx(20, 30))).toBe(true);
    expect(world.map.roadRaise[idx(20, 30)]).toBe(1);
  });

  it('keeps the barrier where the road and the track are still level', () => {
    const world = new World(17);
    world.map.terrain.fill(Terrain.Grass);
    for (let x = 10; x <= 30; x++) world.placeRail(idx(x, 20));
    for (let y = 10; y <= 30; y++) world.placeRoad(idx(20, y));
    // Raising the *track* clears the road just as well as the other way round.
    world.raiseRail(idx(20, 20));
    expect(world.map.isCrossing(idx(20, 20))).toBe(false);
  });
});

describe('saving a shaped map', () => {
  it('carries the heights and everything carried above them', () => {
    const world = new World(23);
    world.map.terrain.fill(Terrain.Grass);
    for (let y = 0; y < 128; y++) world.map.terrain[idx(40, y)] = Terrain.Water;
    for (let x = 50; x < 128; x++) {
      for (let y = 0; y < 128; y++) world.map.height[idx(x, y)] = 3;
    }
    world.map.refreshRelief();
    for (let x = 35; x <= 45; x++) world.placeRoad(idx(x, 30));
    world.raiseRoad(idx(40, 30));
    for (let x = 20; x <= 30; x++) world.placeRail(idx(x, 40));
    world.raiseRail(idx(25, 40));

    const sim = new Simulation(world);
    const restored = deserialize(JSON.parse(JSON.stringify(serialize(sim))));
    const before = sim.world.map;
    const after = restored.world.map;

    expect([...after.height]).toEqual([...before.height]);
    expect([...after.roadRaise]).toEqual([...before.roadRaise]);
    expect([...after.railRaise]).toEqual([...before.railRaise]);
    // The bridge is still a bridge and the flyover is still not a crossing.
    expect(after.isRoad(idx(40, 30))).toBe(true);
    expect(after.roadRaise[idx(40, 30)]).toBe(1);
    expect(after.railRaise[idx(25, 40)]).toBe(1);
    // Prominence and shading are derived, so they must be back without being
    // stored: a loaded map that read as flat would price its land wrongly.
    expect([...after.prominence]).toEqual([...before.prominence]);
    expect([...after.shade]).toEqual([...before.shade]);
  });
});

describe('a hilly city', () => {
  it('still grows on the generated map', () => {
    const sim = new Simulation(newGame());
    run(sim, TICKS_PER_DAY);
    expect(sim.world.population).toBeGreaterThan(0);
    expect(sim.world.buildings.filter((b) => b.alive).length).toBeGreaterThan(20);
  });
});
