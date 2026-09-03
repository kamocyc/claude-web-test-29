import { describe, expect, it } from 'vitest';
import { TICKS_PER_DAY } from '../config';
import { idx } from '../core/grid';
import { BuildingType, Industry, Terrain } from '../core/types';
import { BuildingIssue, buildingIssue, cityWarnings } from '../sim/diagnostics';
import { Simulation } from '../sim/simulation';
import { industryOf } from '../world/buildings';
import { World } from '../world/world';
import { compactCity, run } from './helpers';

describe('what is wrong with a building', () => {
  it('says the lights are off before anything else', () => {
    const sim = new Simulation(compactCity());
    run(sim, TICKS_PER_DAY);

    const shop = sim.world.buildings.find(
      (b) => b.alive && industryOf(b.type) === Industry.Retail,
    );
    expect(shop).toBeDefined();

    // A dark shop is also empty and also unstaffed; the badge on the map has
    // room for one thing, and the power cut is the one that explains the rest.
    shop!.powered = false;
    shop!.goodsStock = 0;
    expect(buildingIssue(shop!)).toBe(BuildingIssue.NoPower);

    shop!.powered = true;
    expect(buildingIssue(shop!)).toBe(BuildingIssue.NoSupply);

    shop!.goodsStock = 20;
    expect(buildingIssue(shop!)).toBe(
      shop!.occupants.length === 0 ? BuildingIssue.NoStaff : null,
    );
  });

  it('leaves a working building alone', () => {
    const sim = new Simulation(compactCity());
    run(sim, TICKS_PER_DAY);

    const working = sim.world.buildings.find(
      (b) => b.alive && b.powered && b.occupants.length > 0
        && industryOf(b.type) !== Industry.Retail
        && industryOf(b.type) !== Industry.Secondary,
    );
    expect(working).toBeDefined();
    expect(buildingIssue(working!)).toBeNull();
  });

  it('judges a power station on its own terms', () => {
    const world = new World(3);
    world.map.terrain.fill(Terrain.Grass);
    for (let x = 10; x <= 20; x++) world.placeRoad(idx(x, 10));
    const plant = world.placePowerPlant(idx(15, 11));
    expect(plant).not.toBeNull();

    // Nobody works there yet, and that is not what a plant is judged on.
    plant!.powered = true;
    expect(buildingIssue(plant!)).toBeNull();
    plant!.powered = false;
    expect(buildingIssue(plant!)).toBe(BuildingIssue.NoPower);
  });
});

describe('what is wrong with the city', () => {
  it('finds nothing wrong with a city that works', () => {
    const sim = new Simulation(compactCity());
    run(sim, TICKS_PER_DAY);

    const critical = cityWarnings(sim).filter((w) => w.severity === 'critical');
    expect(critical).toHaveLength(0);
  });

  it('reports a power shortage, with somewhere to go and look', () => {
    const sim = new Simulation(compactCity());
    run(sim, TICKS_PER_DAY);

    // Take the plants out from under a working city.
    for (const b of sim.world.buildings) {
      if (b.alive && b.type === BuildingType.PowerPlant) sim.world.bulldoze(b.tile);
    }
    run(sim, 400);

    const warning = cityWarnings(sim).find((w) => w.id === 'powerShortfall');
    expect(warning).toBeDefined();
    expect(warning!.severity).toBe('critical');
    expect(warning!.count).toBeGreaterThan(0);
    // The whole point of the panel: it can take the player to the problem.
    expect(warning!.focus).toBeGreaterThanOrEqual(0);
  });

  it('puts the most urgent thing first', () => {
    const sim = new Simulation(compactCity());
    run(sim, TICKS_PER_DAY);
    for (const b of sim.world.buildings) {
      if (b.alive && b.type === BuildingType.PowerPlant) sim.world.bulldoze(b.tile);
    }
    run(sim, 400);

    const warnings = cityWarnings(sim);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0].severity).toBe('critical');
  });
});
