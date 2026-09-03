import { describe, expect, it } from 'vitest';
import { BUS_CAPACITY, TICKS_PER_DAY } from '../config';
import { idx } from '../core/grid';
import { BuildingType, CitizenState, TravelMode, Zone, type BuildingId } from '../core/types';
import { Simulation } from '../sim/simulation';
import { createBusLine, layoutRoadRoute } from '../world/lineBuilder';
import { LineMode } from '../world/transit';
import { World } from '../world/world';
import { powerTown, run } from './helpers';

/**
 * Housing at one end of a long street, jobs at the other, and stops along it.
 *
 * The same shape the rail fixture uses, minus the railway: the point of a bus
 * is that it needs nothing but the road that is already there.
 */
function busTown(withStops: boolean): { world: World; stops: BuildingId[] } {
  const w = new World(53);
  w.map.terrain.fill(0);

  const y = 30;
  const WEST = 10;
  const EAST = 44;

  for (const row of [y, y + 4]) {
    for (let x = WEST - 4; x <= EAST + 4; x++) w.placeRoad(idx(x, row));
  }
  for (const x of [WEST - 4, WEST + 6, 27, EAST - 6, EAST + 4]) {
    for (let k = y; k <= y + 4; k++) w.placeRoad(idx(x, k));
  }

  const stops: BuildingId[] = [];
  if (withStops) {
    for (const x of [WEST, 28, EAST]) {
      const stop = w.placeBusStop(idx(x, y + 1));
      if (stop) stops.push(stop.id);
    }
  }

  powerTown(w);

  for (const row of [y - 1, y + 5]) {
    for (let x = WEST - 4; x <= WEST + 6; x++) {
      const tile = idx(x, row);
      if (w.adjacentRoad(tile) >= 0) w.paintZone(tile, Zone.ResidentialLow);
    }
    for (let x = EAST - 6; x <= EAST + 4; x++) {
      const tile = idx(x, row);
      if (w.adjacentRoad(tile) >= 0) w.paintZone(tile, Zone.Commercial);
    }
  }
  return { world: w, stops };
}

describe('bus routes', () => {
  it('refuses to open a route whose stops the roads do not join up', () => {
    const w = new World(7);
    w.map.terrain.fill(0);
    for (let x = 5; x <= 15; x++) w.placeRoad(idx(x, 10));
    for (let x = 40; x <= 50; x++) w.placeRoad(idx(x, 10));

    const a = w.placeBusStop(idx(6, 11))!;
    const b = w.placeBusStop(idx(45, 11))!;
    expect(layoutRoadRoute(w, [a.id, b.id])).toBeNull();
    expect(createBusLine(w, [a.id, b.id])).toBeNull();
  });

  it('opens over roads that already exist, and builds nothing', () => {
    const { world, stops } = busTown(true);
    const roadsBefore = world.countTiles(world.map.road);
    const railsBefore = world.countTiles(world.map.rail);

    const line = createBusLine(world, stops)!;
    expect(line).not.toBeNull();
    expect(line.mode).toBe(LineMode.Road);
    // Every tile of the route is a road, and not one of them is new.
    expect(line.route.every((t) => world.map.isRoad(t))).toBe(true);
    expect(world.countTiles(world.map.road)).toBe(roadsBefore);
    expect(world.countTiles(world.map.rail)).toBe(railsBefore);
  });

  it('runs its buses round the stops, in traffic', () => {
    const { world, stops } = busTown(true);
    const line = createBusLine(world, stops)!;
    const sim = new Simulation(world);

    expect(line.vehicles.length).toBeGreaterThan(0);
    const bus = world.buses[line.vehicles[0] - 3_000_000];
    const startedAt = bus.nextStop;

    run(sim, 2000);
    // It got somewhere, and it is calling at stops rather than driving in a
    // straight line forever.
    expect(bus.nextStop === startedAt ? bus.path !== null : true).toBe(true);
    const served = world.buses.some((b) => b.line === line.id && b.nextStop !== startedAt);
    expect(served).toBe(true);
  });

  it('carries commuters end to end, and hands them back on foot', () => {
    const { world, stops } = busTown(true);
    createBusLine(world, stops);
    const sim = new Simulation(world);
    run(sim, TICKS_PER_DAY);

    const riders = world.citizens.filter((c) => c.mode === TravelMode.Transit);
    expect(riders.length).toBeGreaterThan(0);

    run(sim, TICKS_PER_DAY);
    const line = world.lines[0];
    expect(line.ridership).toBeGreaterThan(0);
    for (const c of riders) {
      expect([CitizenState.AtHome, CitizenState.AtWork, CitizenState.ToWork,
        CitizenState.ToHome, CitizenState.Waiting, CitizenState.Riding,
        CitizenState.ToShop, CitizenState.AtShop]).toContain(c.state);
    }
    // Nobody is carried past the capacity of the vehicle they are on.
    for (const bus of world.buses) {
      expect(bus.passengers.length).toBeLessThanOrEqual(BUS_CAPACITY);
    }
  });

  it('keeps running when a road on the route is taken up, if another way exists', () => {
    const { world, stops } = busTown(true);
    const line = createBusLine(world, stops)!;
    const sim = new Simulation(world);
    run(sim, 500);

    // Cut the northern street; the southern one still joins every stop.
    for (let x = 20; x <= 30; x++) world.bulldoze(idx(x, 30));
    run(sim, 500);

    expect(world.lineIsAlive(line)).toBe(true);
    expect(line.route.every((t) => world.map.isRoad(t))).toBe(true);
  });

  it('withdraws a route whose stops can no longer be reached at all', () => {
    const { world, stops } = busTown(true);
    const line = createBusLine(world, stops)!;
    const sim = new Simulation(world);
    run(sim, 300);

    // Sever both streets: the western stop is now on its own island.
    for (const row of [30, 34]) {
      for (let x = 20; x <= 30; x++) world.bulldoze(idx(x, row));
    }
    for (let k = 30; k <= 34; k++) world.bulldoze(idx(16, k));

    expect(world.lineIsAlive(line)).toBe(false);
    // The buses are released rather than left driving a route that is gone.
    for (const bus of world.buses) expect(bus.line).toBe(-1);
  });

  it('puts a stop where a bus stop is, and refuses open ground', () => {
    const w = new World(9);
    w.map.terrain.fill(0);
    for (let x = 5; x <= 15; x++) w.placeRoad(idx(x, 10));

    expect(w.placeBusStop(idx(6, 11))).not.toBeNull();
    // Nowhere near a road: a stop nobody can walk to and no bus can call at.
    expect(w.placeBusStop(idx(60, 60))).toBeNull();
    expect(w.buildings[0].type).toBe(BuildingType.BusStop);
  });
});
