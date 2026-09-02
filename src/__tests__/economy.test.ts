import { describe, expect, it } from 'vitest';
import { STARTING_FUNDS, TICKS_PER_DAY } from '../config';
import { idx } from '../core/grid';
import { BuildingType, Resource, Zone } from '../core/types';
import { Expense } from '../sim/economy';
import { Simulation } from '../sim/simulation';
import { World } from '../world/world';
import { compactCity, run } from './helpers';

describe('money', () => {
  it('charges for what gets built, and refuses what cannot be paid for', () => {
    const world = new World(4);
    world.map.terrain.fill(0);
    const sim = new Simulation(world);

    const before = sim.economy.balance;
    expect(world.placeRoad(idx(10, 10))).toBe(true);
    expect(sim.economy.charge(Expense.Road)).toBe(true);
    expect(sim.economy.balance).toBe(before - sim.economy.costOf(Expense.Road));

    sim.economy.balance = 100;
    expect(sim.economy.canAfford(Expense.Station)).toBe(false);
    expect(sim.economy.charge(Expense.Station)).toBe(false);
    // A refused purchase costs nothing at all.
    expect(sim.economy.balance).toBe(100);
  });

  it('bills upkeep for infrastructure every day, whether or not it can pay', () => {
    const world = new World(5);
    world.map.terrain.fill(0);
    for (let x = 5; x <= 60; x++) world.placeRoad(idx(x, 20));
    const sim = new Simulation(world);
    sim.economy.balance = 0;

    const day = sim.economy.settleDay(world);
    expect(day.expenses).toBeGreaterThan(0);
    expect(day.income).toBe(0);
    // Upkeep is taken even into an overdraft: that is the point of it.
    expect(sim.economy.balance).toBeLessThan(0);
    expect(sim.economy.inOverdraft).toBe(true);
  });

  it('taxes what was produced, not what was built', () => {
    const world = compactCity();
    const sim = new Simulation(world);

    // A city that has not run yet has produced nothing, so it owes nothing.
    const idle = sim.economy.settleDay(world);
    expect(idle.income).toBe(0);

    run(sim, TICKS_PER_DAY);
    const working = sim.economy.settleDay(world);
    expect(working.income).toBeGreaterThan(0);
    expect(sim.economy.breakdown.residentialTax).toBeGreaterThan(0);
  });

  it('collects more when the rate goes up', () => {
    const world = compactCity();
    const sim = new Simulation(world);
    run(sim, TICKS_PER_DAY);

    sim.economy.setRate('residential', 0.1);
    const low = sim.economy.settleDay(world).income;
    sim.economy.setRate('residential', 0.2);
    const high = sim.economy.settleDay(world).income;

    expect(high).toBeGreaterThan(low);
    // ...and the rate is clamped rather than accepted blindly.
    sim.economy.setRate('residential', 5);
    expect(sim.economy.rates.residential).toBeLessThanOrEqual(0.3);
    sim.economy.setRate('residential', -1);
    expect(sim.economy.rates.residential).toBe(0);
  });

  it('lends money, charges interest on it, and takes repayment', () => {
    const world = compactCity();
    const sim = new Simulation(world);

    expect(sim.economy.borrow()).toBe(true);
    expect(sim.economy.balance).toBeGreaterThan(STARTING_FUNDS);
    expect(sim.economy.debt).toBeGreaterThan(0);

    const owed = sim.economy.debt;
    sim.economy.settleDay(world);
    expect(sim.economy.breakdown.interest).toBeGreaterThan(0);

    expect(sim.economy.repay()).toBe(true);
    expect(sim.economy.debt).toBeLessThan(owed);
  });

  it('lets a working city pay for itself', () => {
    const world = compactCity();
    const sim = new Simulation(world);
    run(sim, TICKS_PER_DAY * 4);

    // The city has to be doing all of it: powered, employed, and selling.
    expect(sim.power.report.unpowered).toBe(0);
    expect(sim.chain.report.goodsSold).toBeGreaterThan(0);
    expect(sim.world.population).toBeGreaterThan(100);

    // The books the simulation closed at midnight, not a fresh settlement:
    // settling twice would read a day in which nothing had been sold yet.
    const day = sim.economy.lastDay;
    expect(day.income).toBeGreaterThan(day.expenses);
    expect(sim.economy.balance).toBeGreaterThan(0);
  });
});

describe('the supply chain', () => {
  it('runs raw materials through factories into shops and out to residents', () => {
    const sim = new Simulation(compactCity());
    run(sim, TICKS_PER_DAY * 2);

    const report = sim.chain.report;
    expect(report.rawProduced).toBeGreaterThan(0);
    expect(report.goodsProduced).toBeGreaterThan(0);
    expect(report.goodsSold).toBeGreaterThan(0);

    const of = (type: BuildingType) =>
      sim.world.buildings.filter((b) => b.alive && b.type === type);
    expect(of(BuildingType.Farm).length + of(BuildingType.Mine).length).toBeGreaterThan(0);
    expect(of(BuildingType.Factory).length).toBeGreaterThan(0);
    expect(of(BuildingType.Shop).some((b) => b.goodsStock > 0)).toBe(true);
  });

  it('starves shops that no road connects to the industry', () => {
    // The same city, but with the industrial strip cut off from everything.
    const world = compactCity();
    const sim = new Simulation(world);
    run(sim, TICKS_PER_DAY * 2);
    expect(sim.chain.report.goodsProduced).toBeGreaterThan(0);
    const before = sim.chain.report.goodsSold;
    expect(before).toBeGreaterThan(0);

    for (let y = 0; y < 128; y++) {
      const tile = idx(CUT_COLUMN, y);
      if (world.map.isRoad(tile)) world.bulldoze(tile);
    }
    // Long enough for the shelves to empty: the shops keep selling what they
    // already had, which is exactly what a real supply failure looks like.
    run(sim, TICKS_PER_DAY * 3);

    // Production continues on the far side; it just cannot get to the shops.
    expect(sim.chain.report.goodsSold).toBeLessThan(before / 3);
    expect(sim.chain.report.shopsEmpty).toBeGreaterThan(0);
    expect(sim.chain.serviceLevel(world)).toBeLessThan(0.5);
  });

  it('cannot zone primary industry where the ground does not support it', () => {
    const world = new World(9);
    world.map.terrain.fill(0);
    world.map.resource.fill(Resource.None);
    for (let x = 5; x <= 20; x++) world.placeRoad(idx(x, 20));

    const bare = idx(10, 21);
    expect(world.paintZone(bare, Zone.Farm)).toBe(false);
    expect(world.paintZone(bare, Zone.Mining)).toBe(false);
    expect(world.paintZone(bare, Zone.Fishery)).toBe(false);
    // Ordinary zones do not care about the ground.
    expect(world.paintZone(bare, Zone.Commercial)).toBe(true);

    world.map.resource[bare] = Resource.Fertile;
    expect(world.paintZone(bare, Zone.Farm)).toBe(true);
  });

  it('puts a fishery on the shore and nowhere else', () => {
    const world = new World(10);
    world.map.terrain.fill(0);
    for (let x = 5; x <= 20; x++) world.placeRoad(idx(x, 20));
    world.map.terrain[idx(10, 22)] = 1;

    expect(world.paintZone(idx(10, 21), Zone.Fishery)).toBe(true);
    expect(world.paintZone(idx(15, 21), Zone.Fishery)).toBe(false);
  });
});

export const CUT_COLUMN = 40;
