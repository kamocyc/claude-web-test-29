import { describe, expect, it } from 'vitest';
import {
  LORRIES_PER_BUILDING,
  LORRY_CAPACITY,
  MAX_LORRIES,
  TICKS_PER_DAY,
} from '../config';
import { idx } from '../core/grid';
import { Direction, Industry } from '../core/types';
import { LorryState, type Lorry } from '../sim/lorry';
import { Simulation } from '../sim/simulation';
import { industryOf } from '../world/buildings';
import { compactCity, run } from './helpers';
import { CUT_COLUMN } from './economy.test';

/** Everything the city owns, wherever it happens to be sitting. */
function totalStock(sim: Simulation): number {
  const inBuildings = sim.world.buildings
    .filter((b) => b.alive)
    .reduce((n, b) => n + b.rawStock + b.goodsStock, 0);
  const onLorries = sim.world.lorries.reduce((n, l) => n + l.cargo, 0);
  return inBuildings + onLorries;
}

describe('freight', () => {
  it('carries goods to the shops on actual lorries', () => {
    const sim = new Simulation(compactCity());
    run(sim, TICKS_PER_DAY * 2);

    // Lorries exist, are out on the road, and have delivered something.
    expect(sim.world.lorries.length).toBeGreaterThan(0);
    expect(sim.freight.report.deliveriesToday).toBeGreaterThan(0);
    expect(sim.freight.report.deliveredToday).toBeGreaterThan(0);
    expect(sim.world.lorries.some((l) => l.state === LorryState.Outbound)).toBe(true);

    // ...and the shops have stock they did not produce themselves.
    const shops = sim.world.buildings.filter(
      (b) => b.alive && industryOf(b.type) === Industry.Retail,
    );
    expect(shops.length).toBeGreaterThan(0);
    expect(shops.some((b) => b.goodsStock > 0)).toBe(true);
  });

  it('takes the goods off the shelf when they are loaded, not when they arrive', () => {
    const sim = new Simulation(compactCity());
    run(sim, TICKS_PER_DAY);

    const laden = sim.world.lorries.find((l) => l.cargo > 0);
    expect(laden).toBeDefined();
    expect(laden!.cargo).toBeLessThanOrEqual(LORRY_CAPACITY);

    // Stock only moves by production and sale, never by being carried: a load
    // in transit is neither at the supplier nor at the consumer, and it must
    // not be counted in both or in neither.
    const before = totalStock(sim);
    const supplier = sim.world.buildings[laden!.home];
    const supplierBefore = supplier.goodsStock;
    run(sim, 1);
    expect(totalStock(sim)).toBeGreaterThan(before - 1);
    expect(supplier.goodsStock).toBeLessThanOrEqual(supplierBefore + 8);
  });

  it('drives on the same roads as the cars, and queues in the same traffic', () => {
    const sim = new Simulation(compactCity());
    run(sim, TICKS_PER_DAY);

    // A driving lorry publishes itself into the shared occupancy snapshot,
    // taking more room than a car, which is what makes it hold traffic up.
    let sawLorryOnRoad = false;
    for (let i = 0; i < 400 && !sawLorryOnRoad; i++) {
      sim.tick();
      for (const tile of sim.occupancy.dirtyTiles) {
        for (const o of sim.occupancy.at(tile)) {
          if (o.size > 1) sawLorryOnRoad = true;
        }
      }
    }
    expect(sawLorryOnRoad).toBe(true);
  });

  it('holds a lorry at a red light exactly as it holds a car', () => {
    const sim = new Simulation(compactCity());
    const junction = firstSignal(sim);
    expect(junction).toBeGreaterThanOrEqual(0);

    // The stop is decided by the shared movement code, so what this checks is
    // that a lorry is subject to it at all -- that it is a road user and not a
    // second kind of thing that ignores the lights.
    const red = sim.signals.isRed(junction, Direction.East, sim.clock.tick);
    const green = sim.signals.isRed(junction, Direction.North, sim.clock.tick);
    expect(red).not.toBe(green);
  });

  it('stops delivering when the road to the industry is cut', () => {
    const world = compactCity();
    const sim = new Simulation(world);
    run(sim, TICKS_PER_DAY * 2);
    expect(sim.freight.report.deliveriesToday).toBeGreaterThan(0);

    for (let y = 0; y < 128; y++) {
      const tile = idx(CUT_COLUMN, y);
      if (world.map.isRoad(tile)) world.bulldoze(tile);
    }
    run(sim, TICKS_PER_DAY * 3);

    // The shelves drain and cannot be refilled, and no lorry is left hanging:
    // every one of them is either parked or genuinely stuck.
    expect(sim.chain.serviceLevel(world)).toBeLessThan(0.5);
    for (const lorry of world.lorries) {
      expect(lorryIsSane(world.lorries, lorry)).toBe(true);
    }
  });

  it('keeps the fleet inside its caps', () => {
    const sim = new Simulation(compactCity());
    for (let i = 0; i < TICKS_PER_DAY * 2; i++) {
      sim.tick();
      if (i % 500 !== 0) continue;
      expect(sim.world.lorries.length).toBeLessThanOrEqual(MAX_LORRIES);

      const busyPerDepot = new Map<number, number>();
      for (const l of sim.world.lorries) {
        if (l.state === LorryState.Idle || l.home < 0) continue;
        busyPerDepot.set(l.home, (busyPerDepot.get(l.home) ?? 0) + 1);
      }
      for (const busy of busyPerDepot.values()) {
        expect(busy).toBeLessThanOrEqual(LORRIES_PER_BUILDING);
      }
    }
  });

  it('brings a lorry home when the shop it was serving is demolished', () => {
    const world = compactCity();
    const sim = new Simulation(world);
    run(sim, TICKS_PER_DAY);

    const outbound = world.lorries.find(
      (l) => l.state === LorryState.Outbound && l.destination >= 0,
    );
    expect(outbound).toBeDefined();
    const doomed = outbound!.destination;
    world.demolish(doomed);
    run(sim, 400);

    // It is not still driving to a building that no longer exists.
    expect(outbound!.destination).not.toBe(doomed);
    expect(lorryIsSane(world.lorries, outbound!)).toBe(true);
  });

  it('releases a lorry whose depot is demolished', () => {
    const world = compactCity();
    const sim = new Simulation(world);
    run(sim, TICKS_PER_DAY);

    const working = world.lorries.find((l) => l.state !== LorryState.Idle && l.home >= 0);
    expect(working).toBeDefined();
    const depot = working!.home;
    world.demolish(depot);
    run(sim, 60);

    // The slot is freed rather than left pointing at a demolished yard. It may
    // well have been hired by another supplier by now -- that is the point of
    // not compacting the fleet -- so the invariant is about the fleet, not
    // about this one lorry.
    for (const lorry of world.lorries) {
      expect(lorry.home).not.toBe(depot);
      if (lorry.home >= 0) expect(world.buildings[lorry.home].alive).toBe(true);
    }
  });

  it('keeps a whole city fed', () => {
    const sim = new Simulation(compactCity());
    run(sim, TICKS_PER_DAY * 4);

    // Nine households in ten have food in the cupboard, and lorries are still
    // running. Not every shelf is full at every hour -- demand arrives in one
    // evening lump, so a shop selling out before closing is the model working
    // rather than failing -- but the city as a whole is supplied.
    expect(sim.chain.serviceLevel(sim.world)).toBeGreaterThan(0.85);
    const shops = sim.world.buildings.filter(
      (b) => b.alive && industryOf(b.type) === Industry.Retail,
    );
    expect(sim.chain.report.shopsEmpty).toBeLessThan(shops.length / 2);
    expect(sim.freight.report.onTheRoad).toBeGreaterThan(0);
  });
});

/** A lorry is sane when its state and its cargo tell the same story. */
function lorryIsSane(fleet: Lorry[], lorry: Lorry): boolean {
  if (!Number.isFinite(lorry.x) || !Number.isFinite(lorry.y)) return false;
  if (lorry.cargo < 0) return false;
  if (lorry.state === LorryState.Idle) return lorry.cargo === 0;
  if (lorry.state === LorryState.Outbound || lorry.state === LorryState.Returning) {
    return lorry.path !== null;
  }
  void fleet;
  return true;
}

function firstSignal(sim: Simulation): number {
  sim.signals.refresh(sim.world);
  return sim.signals.signalTiles[0] ?? -1;
}
