import { describe, expect, it } from 'vitest';
import { PATIENCE_HOURS, TICKS_PER_DAY, UNHAPPY_THRESHOLD } from '../config';
import { idx } from '../core/grid';
import { BuildingType, Zone } from '../core/types';
import { Simulation } from '../sim/simulation';
import { World } from '../world/world';
import { compactCity, flatten, run } from './helpers';

/** Two road networks that do not touch, with a plant on the left one only. */
function splitTown(): World {
  const w = new World(17);
  w.map.terrain.fill(0);
  flatten(w);

  for (let x = 5; x <= 25; x++) w.placeRoad(idx(x, 20));
  for (let x = 60; x <= 80; x++) w.placeRoad(idx(x, 20));

  for (const x of [10, 15, 65, 70]) {
    w.paintZone(idx(x, 21), Zone.Commercial);
    w.addBuilding(idx(x, 21), BuildingType.Shop);
  }
  w.placePowerPlant(idx(6, 21));
  return w;
}

describe('electricity', () => {
  it('powers the buildings on a plant\'s own road network and no others', () => {
    const world = splitTown();
    const sim = new Simulation(world);
    sim.power.update(world);

    const shops = world.buildings.filter((b) => b.type === BuildingType.Shop);
    const west = shops.filter((b) => b.tile % 128 < 40);
    const east = shops.filter((b) => b.tile % 128 >= 40);

    expect(west.every((b) => b.powered)).toBe(true);
    expect(east.some((b) => b.powered)).toBe(false);
    expect(sim.power.report.unpowered).toBe(east.length);
  });

  it('follows a new road that joins the two halves', () => {
    const world = splitTown();
    const sim = new Simulation(world);
    sim.power.update(world);
    expect(sim.power.report.unpowered).toBeGreaterThan(0);

    for (let x = 25; x <= 60; x++) world.placeRoad(idx(x, 20));
    sim.power.update(world);

    expect(sim.power.report.unpowered).toBe(0);
    expect(world.buildings.every((b) => !b.alive || b.powered)).toBe(true);
  });

  it('browns out the city when demand outgrows the plants', () => {
    const world = compactCity();
    const sim = new Simulation(world);
    run(sim, TICKS_PER_DAY * 2);
    expect(sim.power.report.unpowered).toBe(0);

    // Demolish every plant but one and watch the shortfall appear.
    const plants = world.buildings.filter((b) => b.alive && b.type === BuildingType.PowerPlant);
    for (const p of plants.slice(1)) world.demolish(p.id);
    sim.power.update(world);

    expect(sim.power.report.supply).toBeLessThan(sim.power.report.demand);
    expect(sim.power.report.unpowered).toBeGreaterThan(0);
  });

  it('stops the supply chain where the lights are off', () => {
    const world = compactCity();
    const sim = new Simulation(world);
    run(sim, TICKS_PER_DAY * 2);
    expect(sim.chain.report.goodsProduced).toBeGreaterThan(0);

    for (const b of world.buildings) {
      if (b.alive && b.type === BuildingType.PowerPlant) world.demolish(b.id);
    }
    // Two days: the first still contains the morning's trade, because the
    // shops were selling to real people right up until the lights went out.
    run(sim, TICKS_PER_DAY * 2);

    expect(sim.chain.report.goodsProduced).toBe(0);
    expect(sim.economy.lastDay.income).toBe(0);
  });
});

describe('noise and land value', () => {
  it('is loudest at the industry and fades with distance', () => {
    const world = compactCity();
    const sim = new Simulation(world);
    run(sim, TICKS_PER_DAY * 2);

    const factory = world.buildings.find((b) => b.alive && b.type === BuildingType.Factory);
    expect(factory).toBeDefined();

    // Compared against open country rather than against a housing street:
    // busy streets are genuinely noisy, which is the point of the field.
    const atSource = sim.noise.at(factory!.tile);
    const openCountry = sim.noise.at(idx(120, 120));
    expect(atSource).toBeGreaterThan(0);
    expect(openCountry).toBe(0);
    expect(atSource).toBeGreaterThan(sim.noise.at(factory!.tile + 8));
  });

  it('prices quiet land above noisy land', () => {
    const world = compactCity();
    const sim = new Simulation(world);
    run(sim, TICKS_PER_DAY * 2);

    let noisiest = -1;
    let quietest = -1;
    for (const b of world.buildings) {
      if (!b.alive) continue;
      if (noisiest < 0 || sim.noise.at(b.tile) > sim.noise.at(noisiest)) noisiest = b.tile;
      if (quietest < 0 || sim.noise.at(b.tile) < sim.noise.at(quietest)) quietest = b.tile;
    }
    expect(sim.noise.at(noisiest)).toBeGreaterThan(sim.noise.at(quietest));
    expect(sim.landValue.at(noisiest)).toBeLessThan(sim.landValue.at(quietest));
  });

  it('keeps every value inside its scale', () => {
    const world = compactCity();
    const sim = new Simulation(world);
    run(sim, TICKS_PER_DAY * 2);

    for (let tile = 0; tile < 128 * 128; tile += 37) {
      expect(sim.noise.at(tile)).toBeGreaterThanOrEqual(0);
      expect(sim.noise.at(tile)).toBeLessThanOrEqual(100);
      expect(sim.landValue.at(tile)).toBeGreaterThanOrEqual(0);
      expect(sim.landValue.at(tile)).toBeLessThanOrEqual(100);
    }
  });
});

describe('happiness and migration', () => {
  it('brings people to a working city', () => {
    const sim = new Simulation(compactCity());
    run(sim, TICKS_PER_DAY * 2);

    expect(sim.world.population).toBeGreaterThan(100);
    expect(sim.happiness.breakdown.overall).toBeGreaterThan(UNHAPPY_THRESHOLD);
    expect(sim.happiness.breakdown.employment).toBeGreaterThan(50);
  });

  it('empties a city that stops working, and renumbers cleanly as it goes', () => {
    const world = compactCity();
    const sim = new Simulation(world);
    run(sim, TICKS_PER_DAY * 2);
    const before = world.population;
    expect(before).toBeGreaterThan(100);

    // Take away the power and every workplace -- and the zoning behind them,
    // so the city cannot simply rebuild what was demolished.
    for (let tile = 0; tile < world.map.zone.length; tile++) {
      const zone = world.map.getZone(tile);
      if (zone !== Zone.ResidentialLow && zone !== Zone.ResidentialHigh) {
        world.map.zone[tile] = Zone.None;
      }
    }
    for (const b of world.buildings) {
      if (!b.alive) continue;
      if (b.type !== BuildingType.House && b.type !== BuildingType.Apartment) {
        world.demolish(b.id);
      }
    }
    run(sim, Math.floor(TICKS_PER_DAY * (PATIENCE_HOURS / 24 + 1)));

    expect(sim.happiness.breakdown.overall).toBeLessThan(UNHAPPY_THRESHOLD + 15);
    expect(world.population).toBeLessThan(before);

    // Every id is still an index into the array, and every occupant list still
    // points at somebody who actually lives there.
    world.citizens.forEach((c, i) => expect(c.id).toBe(i));
    for (const b of world.buildings) {
      for (const id of b.occupants) {
        expect(id).toBeGreaterThanOrEqual(0);
        expect(id).toBeLessThan(world.citizens.length);
      }
    }
    for (const train of world.trains) {
      for (const id of train.passengers) expect(id).toBeLessThan(world.citizens.length);
    }
  });

  it('keeps a departing neighbour from changing anyone else\'s routine', () => {
    const world = compactCity();
    const sim = new Simulation(world);
    run(sim, TICKS_PER_DAY);

    const before = world.citizens.map((c) => [c.name, c.seed] as const);
    // Simulate the compaction directly by making the first person leave.
    const victim = world.citizens[0];
    victim.happiness = 0;
    victim.unhappyHours = PATIENCE_HOURS;
    sim.happiness.migrate(world);

    const survivor = world.citizens[0];
    expect(survivor.name).not.toBe(before[0][0]);
    // Their seed came with them, so their working day did not move.
    const original = before.find(([name]) => name === survivor.name);
    expect(survivor.seed).toBe(original![1]);
  });
});
