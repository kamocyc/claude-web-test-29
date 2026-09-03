import { describe, expect, it } from 'vitest';
import { POWER_PLANT_OUTPUT, TICKS_PER_DAY } from '../config';
import { idx } from '../core/grid';
import { BuildingType, Terrain } from '../core/types';
import { Simulation } from '../sim/simulation';
import { World } from '../world/world';
import { compactCity, run } from './helpers';

/**
 * Two districts that share no road, so nothing can flow between them: the
 * shape a single "supply vs demand" figure gets wrong.
 */
function twoIslands(): World {
  const w = new World(5);
  w.map.terrain.fill(Terrain.Grass);

  for (const band of [[10, 24], [50, 64]]) {
    for (let x = band[0]; x <= band[1]; x++) w.placeRoad(idx(x, 20));
    // Houses placed rather than grown: a district with no electricity never
    // grows one on its own, and the dark district is the point of the test.
    for (let x = band[0]; x <= band[1]; x += 2) w.addBuilding(idx(x, 21), BuildingType.House);
  }
  return w;
}

describe('the power report', () => {
  it('counts a shortage per road network, not across the city', () => {
    const world = twoIslands();
    const sim = new Simulation(world);

    // One plant, on the western island only.
    expect(world.placePowerPlant(idx(25, 20))).not.toBeNull();
    sim.power.update(world);

    const report = sim.power.report;
    expect(report.networks.length).toBeGreaterThanOrEqual(2);
    expect(report.plants).toBe(1);

    // Plenty of electricity in total, even from a plant nobody staffs yet...
    expect(report.supply).toBeGreaterThan(0);
    expect(report.supply).toBeLessThanOrEqual(POWER_PLANT_OUTPUT);
    expect(report.supply).toBeGreaterThan(report.demand);
    // ...and the eastern island is still dark, which is what has to show up.
    expect(report.shortfall).toBeGreaterThan(0);
    expect(report.unpowered).toBeGreaterThan(0);
    expect(report.networks[0].demand).toBeGreaterThan(report.networks[0].supply);
  });

  it('separates buildings with no road at all from ones short of capacity', () => {
    const sim = new Simulation(compactCity());
    run(sim, TICKS_PER_DAY);
    expect(sim.power.report.offGrid).toBe(0);

    // A building whose only access road is taken away has no cable either.
    const victim = sim.world.buildings.find((b) => b.alive && b.accessRoad >= 0);
    expect(victim).toBeDefined();
    for (let i = 0; i < sim.world.map.road.length; i++) {
      if (sim.world.map.isRoad(i) && sim.world.adjacentRoad(victim!.tile) === i) {
        sim.world.bulldoze(i);
      }
    }
    run(sim, 400);
    expect(sim.power.report.offGrid).toBeGreaterThan(0);
  });

  it('reports nothing for an empty map', () => {
    const sim = new Simulation(new World(9));
    sim.power.update(sim.world);
    const report = sim.power.report;
    expect(report.supply).toBe(0);
    expect(report.demand).toBe(0);
    expect(report.shortfall).toBe(0);
    expect(report.networks).toHaveLength(0);
  });
});

describe('the land value breakdown', () => {
  it('adds up to the value the field is heading for', () => {
    const sim = new Simulation(compactCity());
    run(sim, TICKS_PER_DAY);

    const home = sim.world.buildings.find((b) => b.alive && b.type === BuildingType.House);
    expect(home).toBeDefined();

    const f = sim.landValue.factorsAt(sim.world, sim.noise, home!.tile);
    const sum = f.base + f.water + f.greenery + f.station + f.shops + f.offices + f.noise;
    expect(f.target).toBeCloseTo(Math.min(100, Math.max(0, sum)), 5);
    // The panel shows `current`; it must be the same number the map paints.
    expect(f.current).toBe(sim.landValue.at(home!.tile));
  });

  it('agrees with the field the simulation actually settles on', () => {
    const sim = new Simulation(compactCity());
    // Long enough for a value that moves 25% of the way per update to arrive.
    run(sim, TICKS_PER_DAY * 2);

    const home = sim.world.buildings.find((b) => b.alive && b.type === BuildingType.House);
    const f = sim.landValue.factorsAt(sim.world, sim.noise, home!.tile);
    // Not equality: the field chases its target by a quarter of the gap each
    // update, and the target itself moves as the traffic outside comes and
    // goes. A few points of lag is the model, not a disagreement.
    expect(Math.abs(f.current - f.target)).toBeLessThan(5);
  });

  it('credits a station and debits the noise', () => {
    const sim = new Simulation(compactCity());
    run(sim, 200);

    const world = sim.world;
    const spot = world.map.at(30, 22);
    const before = sim.landValue.factorsAt(world, sim.noise, spot);
    expect(before.station).toBe(0);

    // A station within walking distance is the biggest thing a player can do
    // to a tile's value, so it has to show up as its own term.
    const station = world.placeStation(world.map.at(31, 23));
    expect(station).not.toBeNull();
    const after = sim.landValue.factorsAt(world, sim.noise, spot);
    expect(after.station).toBeGreaterThan(0);
    expect(after.target).toBeGreaterThan(before.target);

    // Noise only ever takes value away.
    expect(after.noise).toBeLessThanOrEqual(0);
  });
});
