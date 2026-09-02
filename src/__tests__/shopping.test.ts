import { describe, expect, it } from 'vitest';
import { SHOPPING_BASKET, SHOPPING_TRIGGER, TICKS_PER_DAY } from '../config';
import { CitizenState, Industry, Zone } from '../core/types';
import { Simulation } from '../sim/simulation';
import { industryOf } from '../world/buildings';
import { chooseShop, shoppingSatisfaction } from '../sim/shopping';
import { compactCity, run } from './helpers';

describe('shopping trips', () => {
  it('sends people to the shops and brings them home with the groceries', () => {
    const sim = new Simulation(compactCity());

    let sawTravelling = false;
    let sawInShop = false;
    for (let i = 0; i < TICKS_PER_DAY * 2; i++) {
      sim.tick();
      for (const c of sim.world.citizens) {
        if (c.state === CitizenState.ToShop) sawTravelling = true;
        if (c.state === CitizenState.AtShop) sawInShop = true;
      }
    }

    expect(sawTravelling).toBe(true);
    expect(sawInShop).toBe(true);

    // Cupboards are being filled, not just drained.
    const pantries = sim.world.citizens.map((c) => c.pantry);
    expect(Math.max(...pantries)).toBeGreaterThan(1);
    const mean = pantries.reduce((n, p) => n + p, 0) / pantries.length;
    expect(mean).toBeGreaterThan(0.5);
  });

  it('takes what it buys off the shop shelf, and taxes it', () => {
    const sim = new Simulation(compactCity());
    // Two days, then into the evening: `soldToday` is reset when the books
    // close at midnight, so sampling exactly on the hour would read a fresh
    // ledger rather than a day's trade.
    run(sim, TICKS_PER_DAY * 2 + Math.floor((TICKS_PER_DAY * 20) / 24));

    const shops = sim.world.buildings.filter(
      (b) => b.alive && industryOf(b.type) === Industry.Retail,
    );
    // Sales are real purchases by real people, so they show up both on the
    // shop's books and in the day's commercial tax.
    expect(shops.some((b) => b.soldToday > 0)).toBe(true);
    expect(sim.economy.breakdown.commercialTax).toBeGreaterThan(0);
    expect(sim.chain.report.goodsSold).toBeGreaterThanOrEqual(0);
  });

  it('shops in the evening rather than in the rush hour', () => {
    const sim = new Simulation(compactCity());
    run(sim, TICKS_PER_DAY * 2);

    const shoppersNow = (): number => sim.world.citizens.filter(
      (c) => c.state === CitizenState.ToShop || c.state === CitizenState.AtShop,
    ).length;

    let smallHours = 0;
    let evening = 0;
    for (let i = 0; i < TICKS_PER_DAY; i++) {
      sim.tick();
      const hour = sim.clock.hour;
      if (hour >= 2 && hour < 6) smallHours = Math.max(smallHours, shoppersNow());
      if (hour >= 18 && hour < 22) evening = Math.max(evening, shoppersNow());
    }

    expect(evening).toBeGreaterThan(smallHours);
    expect(smallHours).toBe(0);
  });

  it('does not set out for a shop that has nothing on the shelf', () => {
    const world = compactCity();
    const sim = new Simulation(world);
    run(sim, TICKS_PER_DAY);

    const hungry = world.citizens.find((c) => c.pantry < 1);
    expect(hungry).toBeDefined();

    // With stock somewhere in reach there is somewhere worth going...
    expect(chooseShop(world, hungry!)).toBeGreaterThanOrEqual(0);

    // ...and with every shelf bare, nobody wastes the trip.
    for (const b of world.buildings) {
      if (b.alive && industryOf(b.type) === Industry.Retail) b.goodsStock = 0;
    }
    expect(chooseShop(world, hungry!)).toBe(-1);
  });

  it('counts a wasted trip against how well fed somebody feels', () => {
    const sim = new Simulation(compactCity());
    run(sim, TICKS_PER_DAY);
    const c = sim.world.citizens[0];

    c.pantry = SHOPPING_BASKET;
    c.lastShopFailed = false;
    expect(shoppingSatisfaction(c)).toBe(1);

    // A day's food is enough to be content; the basket is a stockpile, not a
    // requirement.
    c.pantry = SHOPPING_TRIGGER;
    expect(shoppingSatisfaction(c)).toBe(1);

    c.lastShopFailed = true;
    expect(shoppingSatisfaction(c)).toBeLessThan(1);

    c.pantry = 0;
    expect(shoppingSatisfaction(c)).toBe(0);
  });

  it('leaves a city with no industry hungry rather than driving in circles', () => {
    // compactCity minus its whole chain: shops with nothing to sell, and no
    // zoning left for the city to rebuild the industry on.
    const world = compactCity();
    for (let tile = 0; tile < world.map.zone.length; tile++) {
      const zone = world.map.getZone(tile);
      if (zone === Zone.Industrial || zone === Zone.Farm || zone === Zone.Mining) {
        world.map.zone[tile] = Zone.None;
      }
    }
    for (const b of world.buildings) {
      if (!b.alive) continue;
      const industry = industryOf(b.type);
      if (industry === Industry.Primary || industry === Industry.Secondary) world.demolish(b.id);
      else if (industry === Industry.Retail) b.goodsStock = 0;
    }
    const sim = new Simulation(world);
    run(sim, TICKS_PER_DAY * 4);

    // Hunger shows up in the wellbeing figures...
    expect(sim.chain.serviceLevel(world)).toBeLessThan(0.5);
    expect(sim.happiness.breakdown.services).toBeLessThan(40);

    // ...and not as a permanent traffic jam of people visiting empty shops.
    const shoppers = world.citizens.filter(
      (c) => c.state === CitizenState.ToShop || c.state === CitizenState.AtShop,
    ).length;
    expect(shoppers).toBeLessThan(world.citizens.length * 0.1);
  });

  it('sends the jobless shopping too', () => {
    const sim = new Simulation(compactCity());
    run(sim, TICKS_PER_DAY);

    const jobless = sim.world.citizens.filter((c) => c.work < 0);
    if (jobless.length === 0) return; // A fully employed city has nothing to prove here.

    // They have no commute at all, so the shops are the only reason they ever
    // leave the house -- and they still get one.
    run(sim, TICKS_PER_DAY);
    expect(jobless.some((c) => c.pantry > 0 || c.state === CitizenState.ToShop)).toBe(true);
  });
});
