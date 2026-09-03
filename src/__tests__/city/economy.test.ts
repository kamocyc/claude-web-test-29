import { describe, expect, it } from 'vitest';
import { draw } from '../../track/app/sketch';
import { Treasury, TAX_PER_JOB, TAX_PER_RESIDENT } from '../../city/economy';
import { seedStartingTown } from '../../city/scenario';
import { CitySimulation, SPEEDS } from '../../city/simulation';
import { CityWorld } from '../../city/world';

/**
 * The money.
 *
 * Construction is charged from the engine's own cost figure, so the rules
 * worth pinning down are the ones about *when* that figure turns into a bill:
 * never for the town you are handed, always for what you lay, and never
 * refunded for what you take up.
 */
describe('the treasury', () => {
  it('does not bill the city for the town it starts with', () => {
    const treasury = new Treasury(100);
    expect(treasury.chargeNetwork(90_000, true)).toBe(0);
    expect(treasury.balance).toBe(100);
  });

  it('charges for what is laid after that, once', () => {
    const treasury = new Treasury(1_000);
    treasury.chargeNetwork(500, true);
    expect(treasury.chargeNetwork(700)).toBe(200);
    expect(treasury.balance).toBe(800);
    // The same figure again is not a second bill.
    expect(treasury.chargeNetwork(700)).toBe(0);
    expect(treasury.balance).toBe(800);
  });

  it('does not refund a road taken up', () => {
    const treasury = new Treasury(1_000);
    treasury.chargeNetwork(500, true);
    treasury.chargeNetwork(700);
    expect(treasury.chargeNetwork(500)).toBe(0);
    expect(treasury.balance).toBe(800);
    // ...and laying that stretch again costs again.
    expect(treasury.chargeNetwork(700)).toBe(200);
    expect(treasury.balance).toBe(600);
  });

  it('closes the day on taxes less upkeep', () => {
    const treasury = new Treasury(0);
    const day = treasury.settleDay({ employed: 10, population: 30, upkeep: 100 });
    expect(day.income).toBe(10 * TAX_PER_JOB + 30 * TAX_PER_RESIDENT);
    expect(day.net).toBe(day.income - 100);
    expect(treasury.balance).toBe(day.net);
  });

  it('lets upkeep push the city into the red, but refuses to lay what it cannot pay for', () => {
    const treasury = new Treasury(50);
    treasury.settleDay({ employed: 0, population: 0, upkeep: 400 });
    expect(treasury.inOverdraft).toBe(true);
    expect(treasury.canAfford(1)).toBe(false);
  });
});

describe('the city on the alignment engine', () => {
  it('starts solvent and earns from the town it is given', () => {
    const world = new CityWorld(20260903, true);
    seedStartingTown(world);
    world.rebuild();
    const sim = new CitySimulation(world, 20260903);
    const opening = sim.treasury.balance;

    // The opening town is a gift, not a bill.
    expect(sim.treasury.spent).toBe(0);
    expect(opening).toBeGreaterThan(0);

    // Long enough to run the clock past a midnight, so the books close once.
    sim.speed = SPEEDS.indexOf(10);
    for (let i = 0; i < 160 * 20; i++) sim.step(1 / 20);
    expect(sim.day).toBeGreaterThan(0);

    // The day closed on a real ledger rather than on zeroes.
    expect(sim.treasury.lastDay.income).toBeGreaterThan(0);
    expect(sim.treasury.lastDay.expenses).toBeGreaterThan(0);
    expect(sim.treasury.balance).not.toBe(opening);
  });

  it('bills the player for a road laid after the city is running', () => {
    const world = new CityWorld(20260903, true);
    seedStartingTown(world);
    world.rebuild();
    const sim = new CitySimulation(world, 20260903);
    sim.step(1 / 20);
    expect(sim.treasury.spent).toBe(0);

    // Lay a street the way the build tool does, out into open ground.
    const site = [...world.net.nodes.values()][0]!.pos;
    const costBefore = world.result?.stats.cost ?? 0;
    draw(world.net, world.field, 'road_small', [
      { x: site.x, z: site.z + 300 },
      { x: site.x + 220, z: site.z + 300 },
    ]);
    world.rebuild();
    sim.step(1 / 20);

    const laid = (world.result?.stats.cost ?? 0) - costBefore;
    expect(laid).toBeGreaterThan(0);
    expect(sim.treasury.spent).toBeCloseTo(laid, 6);
    expect(sim.treasury.balance).toBeCloseTo(400_000 - laid, 6);
  });
});
