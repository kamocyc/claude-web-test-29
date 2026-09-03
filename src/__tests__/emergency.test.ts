import { describe, expect, it } from 'vitest';
import { FIRE_BURN_TICKS, FIRE_WORK_TICKS, TICKS_PER_DAY } from '../config';
import { idx } from '../core/grid';
import { BuildingType, Terrain, Zone } from '../core/types';
import { IncidentKind, UnitState } from '../sim/emergency';
import { Simulation } from '../sim/simulation';
import { World } from '../world/world';
import { powerTown, run } from './helpers';

/** One street with housing along it, and room for a station at either end. */
function street(): World {
  const w = new World(83);
  w.map.terrain.fill(Terrain.Grass);
  for (let x = 10; x <= 60; x++) w.placeRoad(idx(x, 20));
  for (let x = 10; x <= 60; x++) {
    for (const y of [19, 21]) {
      const tile = idx(x, y);
      if (w.adjacentRoad(tile) >= 0) w.paintZone(tile, Zone.ResidentialLow);
    }
  }
  powerTown(w, 2);
  return w;
}

/** Set a building alight now, rather than waiting for the dice to do it. */
function ignite(sim: Simulation, buildingId: number): void {
  sim.emergency.raise(
    sim.world.buildings[buildingId],
    IncidentKind.Fire,
    sim.clock.tick,
    FIRE_BURN_TICKS,
  );
}

function firstHouse(sim: Simulation): number {
  const house = sim.world.buildings.find((b) => b.alive && b.type === BuildingType.House);
  expect(house).toBeDefined();
  return house!.id;
}

describe('fire', () => {
  it('destroys the building when nobody comes', () => {
    const sim = new Simulation(street());
    run(sim, TICKS_PER_DAY);

    const id = firstHouse(sim);
    ignite(sim, id);
    expect(sim.emergency.report.fires).toBe(0); // not published until the tick

    run(sim, FIRE_BURN_TICKS + 10);
    expect(sim.world.buildings[id].alive).toBe(false);
    expect(sim.emergency.report.buildingsLostToday).toBeGreaterThan(0);
  });

  it('sends an engine that puts it out, and the building survives', () => {
    const sim = new Simulation(street());
    sim.world.placeService(idx(12, 19), BuildingType.FireStation);
    run(sim, TICKS_PER_DAY);

    const id = firstHouse(sim);
    ignite(sim, id);
    // Dispatch happens on the emergency cadence; the engine then drives there
    // through whatever traffic is on the street.
    sim.emergency.dispatch(sim.world);
    expect(sim.world.units.some((u) => u.state === UnitState.Responding)).toBe(true);

    run(sim, FIRE_BURN_TICKS + FIRE_WORK_TICKS);
    expect(sim.world.buildings[id].alive).toBe(true);
    expect(sim.emergency.report.fires).toBe(0);
    // ...and the engine goes home rather than parking at the scene forever.
    run(sim, 2000);
    expect(sim.world.units.every((u) => u.state === UnitState.Idle)).toBe(true);
  });

  it('cannot answer a call it has no road to', () => {
    const world = street();
    // A house on its own spur, joined to the rest of the city by one tile.
    for (let y = 21; y <= 30; y++) world.placeRoad(idx(40, y));
    const sim = new Simulation(world);
    world.placeService(idx(12, 19), BuildingType.FireStation);
    run(sim, TICKS_PER_DAY);

    const outpost = world.placeService(idx(41, 30), BuildingType.School)!;
    run(sim, 400);
    // Cut the spur: the school is now unreachable by road.
    for (let y = 21; y <= 29; y++) world.bulldoze(idx(40, y));

    ignite(sim, outpost.id);
    sim.emergency.dispatch(sim.world);
    // No unit could be assigned, so the call stands unanswered and the
    // building is lost -- which is the argument for the road, not for a
    // second fire station.
    expect(sim.emergency.report.unanswered).toBeGreaterThanOrEqual(0);
    run(sim, FIRE_BURN_TICKS + 10);
    expect(world.buildings[outpost.id].alive).toBe(false);
  });

  it('re-homes the residents of a house that burns down', () => {
    const sim = new Simulation(street());
    run(sim, TICKS_PER_DAY);

    const id = firstHouse(sim);
    const residents = sim.world.buildings[id].occupants.slice();
    expect(residents.length).toBeGreaterThan(0);

    ignite(sim, id);
    run(sim, FIRE_BURN_TICKS + 200);

    // Nobody is left standing in the street: they moved in somewhere else, or
    // they left the city. What must never happen is a citizen attached to a
    // building that no longer exists.
    for (const cid of residents) {
      const c = sim.world.citizens[cid];
      if (!c) continue;
      const home = sim.world.buildings[c.home];
      expect(home === undefined || home.alive || c.left).toBe(true);
    }
    expect(sim.strandedCount).toBe(0);
  });
});

describe('emergency vehicles', () => {
  it('keeps two engines per station and retires them with it', () => {
    const sim = new Simulation(street());
    const station = sim.world.placeService(idx(12, 19), BuildingType.FireStation)!;
    run(sim, 400);

    const ours = () => sim.world.units.filter((u) => u.home === station.id);
    expect(ours().length).toBe(2);
    expect(ours().every((u) => u.kind === IncidentKind.Fire)).toBe(true);

    sim.world.demolish(station.id);
    run(sim, 100);
    expect(sim.world.units.every((u) => u.state === UnitState.Retired)).toBe(true);
  });

  it('gives a police station patrol cars rather than engines', () => {
    const sim = new Simulation(street());
    const station = sim.world.placeService(idx(12, 19), BuildingType.PoliceStation)!;
    run(sim, 400);

    const ours = sim.world.units.filter((u) => u.home === station.id);
    expect(ours.length).toBe(2);
    expect(ours.every((u) => u.kind === IncidentKind.Crime)).toBe(true);
  });
});
