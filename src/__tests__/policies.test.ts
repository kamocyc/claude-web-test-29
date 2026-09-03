import { describe, expect, it } from 'vitest';
import {
  ORDINANCE_ENERGY_SAVING,
  ORDINANCE_TRANSIT_PREFERENCE,
  TICKS_PER_DAY,
  TRANSIT_PREFERENCE,
} from '../config';
import { idx } from '../core/grid';
import { BuildingType } from '../core/types';
import { ALL_ORDINANCES, Ordinance, Policies } from '../sim/policies';
import { Simulation } from '../sim/simulation';
import { transitWins } from '../sim/transitPlanner';
import { specFor } from '../world/buildings';
import { compactCity, run } from './helpers';

describe('ordinances', () => {
  it('starts with none in force, and toggles cleanly', () => {
    const policies = new Policies();
    for (const o of ALL_ORDINANCES) expect(policies.isOn(o)).toBe(false);

    expect(policies.toggle(Ordinance.Greening)).toBe(true);
    expect(policies.isOn(Ordinance.Greening)).toBe(true);
    expect(policies.toggle(Ordinance.Greening)).toBe(false);
    expect(policies.enabled).toHaveLength(0);
  });

  it('moves the number the mode choice was already being made on', () => {
    const policies = new Policies();
    expect(policies.transitPreference).toBeCloseTo(TRANSIT_PREFERENCE, 6);

    // A ride that loses to driving by a whisker...
    const drive = 1000;
    const ride = drive * TRANSIT_PREFERENCE + 1;
    expect(transitWins(ride, drive, policies.transitPreference)).toBe(false);

    // ...wins once the fares are subsidised, and nothing else changed.
    policies.set(Ordinance.TransitSubsidy, true);
    expect(policies.transitPreference)
      .toBeCloseTo(TRANSIT_PREFERENCE * ORDINANCE_TRANSIT_PREFERENCE, 6);
    expect(transitWins(ride, drive, policies.transitPreference)).toBe(true);
  });

  it('takes the energy by-law off what every building draws', () => {
    const policies = new Policies();
    const rated = specFor(BuildingType.Factory).power;
    expect(policies.powerDraw(rated)).toBe(rated);

    policies.set(Ordinance.EnergySaving, true);
    expect(policies.powerDraw(rated)).toBeCloseTo(rated * (1 - ORDINANCE_ENERGY_SAVING), 6);
  });

  it('lowers the city’s power demand once it is in force', () => {
    const world = compactCity();
    const sim = new Simulation(world);
    run(sim, 2000);
    const before = sim.power.report.demand;
    expect(before).toBeGreaterThan(0);

    sim.policies.set(Ordinance.EnergySaving, true);
    sim.power.update(world, sim.policies);
    expect(sim.power.report.demand).toBeLessThan(before);
  });

  it('bills the city daily, in proportion to what it is buying', () => {
    const world = compactCity();
    const sim = new Simulation(world);
    run(sim, TICKS_PER_DAY);

    // Nothing in force costs nothing, however large the city is.
    expect(sim.policies.settleDay(world, 100)).toBe(0);

    sim.policies.set(Ordinance.NightPatrol, true);
    const small = sim.policies.settleDay(world, 0);
    expect(small).toBeGreaterThan(0);
    // The bill follows the city: the patrol is charged per resident.
    expect(sim.policies.costOf(Ordinance.NightPatrol, world))
      .toBeCloseTo(small, 6);
    expect(sim.policies.lastBill.get(Ordinance.NightPatrol)).toBeCloseTo(small, 6);

    // And the subsidy follows the riders it is paying for.
    sim.policies.set(Ordinance.TransitSubsidy, true);
    const quiet = sim.policies.costOf(Ordinance.TransitSubsidy, world, 0);
    const busy = sim.policies.costOf(Ordinance.TransitSubsidy, world, 500);
    expect(quiet).toBe(0);
    expect(busy).toBeGreaterThan(quiet);
  });

  it('shows up in the day’s books as its own line', () => {
    const world = compactCity();
    const sim = new Simulation(world);
    run(sim, TICKS_PER_DAY);

    sim.policies.set(Ordinance.NightPatrol, true);
    const before = sim.economy.balance;
    const result = sim.economy.settleDay(world, sim.policies, 0);

    expect(sim.economy.breakdown.ordinances).toBeGreaterThan(0);
    // The bill is an expense like the upkeep, not a separate ledger.
    expect(result.expenses).toBeGreaterThanOrEqual(sim.economy.breakdown.ordinances);
    expect(sim.economy.balance).toBeCloseTo(before + result.net, 5);
  });

  it('is charged whether or not the city can afford it', () => {
    const world = compactCity();
    const sim = new Simulation(world);
    run(sim, 600);

    sim.economy.restore({
      balance: 10,
      debt: 0,
      rates: sim.economy.rates,
      spentOnBuilding: 0,
    });
    sim.policies.set(Ordinance.FreeClinics, true);
    sim.economy.settleDay(world, sim.policies, 0);
    // An ordinance is upkeep, not construction: it goes through and the
    // overdraft is the consequence the player has to deal with.
    expect(sim.economy.breakdown.ordinances).toBeGreaterThan(0);
  });

  it('makes parks worth more to the ground under the greening by-law', () => {
    const world = compactCity();
    const sim = new Simulation(world);
    run(sim, 1200);

    // A park beside the housing.
    const tile = idx(16, 21);
    world.bulldoze(tile);
    expect(world.placeService(tile, BuildingType.Park)).not.toBeNull();

    const plain = sim.landValue.factorsAt(world, sim.noise, sim.crime, idx(17, 21));
    sim.policies.set(Ordinance.Greening, true);
    const green = sim.landValue.factorsAt(
      world, sim.noise, sim.crime, idx(17, 21), sim.policies,
    );
    expect(plain.parks).toBeGreaterThan(0);
    expect(green.parks).toBeGreaterThan(plain.parks);
  });
});
