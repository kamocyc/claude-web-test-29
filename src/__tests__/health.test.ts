import { describe, expect, it } from 'vitest';
import {
  HEALTH_WITHOUT_HOSPITAL,
  HEALTH_WITH_HOSPITAL,
  STARTING_HEALTH,
  TICKS_PER_DAY,
} from '../config';
import { idx } from '../core/grid';
import { BuildingType, Zone } from '../core/types';
import { healthTarget, treat } from '../sim/health';
import { Ordinance } from '../sim/policies';
import { Service } from '../sim/services';
import { Simulation } from '../sim/simulation';
import { World } from '../world/world';
import { flatten, powerTown, run } from './helpers';

/** Housing on one street, with room for a hospital at the far end. */
function healthTown(): World {
  const w = new World(71);
  w.map.terrain.fill(0);
  flatten(w);

  const y = 30;
  for (let x = 6; x <= 60; x++) w.placeRoad(idx(x, y));
  for (let x = 6; x <= 30; x++) {
    for (const row of [y - 1, y + 1]) {
      const tile = idx(x, row);
      if (w.adjacentRoad(tile) >= 0) w.paintZone(tile, Zone.ResidentialLow);
    }
  }
  for (let x = 40; x <= 58; x++) {
    const tile = idx(x, y + 1);
    if (w.adjacentRoad(tile) >= 0) w.paintZone(tile, Zone.Commercial);
  }
  powerTown(w, 3);
  return w;
}

describe('hospitals and health', () => {
  it('covers the homes a hospital can reach along the roads', () => {
    const world = healthTown();
    const sim = new Simulation(world);
    run(sim, 600);

    expect(sim.services.report.hospitals).toBe(0);
    expect(sim.services.report.healthCovered).toBe(0);

    world.placeService(idx(10, 31), BuildingType.Hospital);
    run(sim, 400);

    expect(sim.services.report.hospitals).toBe(1);
    expect(sim.services.report.healthCovered).toBeGreaterThan(0);
    const home = world.buildings.find((b) => b.type === BuildingType.House)!;
    expect(sim.services.serves(Service.Health, home)).toBe(true);
  });

  it('raises health where it reaches and lets it fall where it does not', () => {
    const world = healthTown();
    const sim = new Simulation(world);
    run(sim, TICKS_PER_DAY);
    expect(world.citizens.length).toBeGreaterThan(0);

    // No hospital: health settles below where everybody arrived.
    for (let hour = 0; hour < 60; hour++) {
      treat(world, sim.services, sim.noise, sim.crime, sim.policies);
    }
    const withoutHospital = mean(world.citizens.map((c) => c.health));
    expect(withoutHospital).toBeLessThan(STARTING_HEALTH);

    // The strip has grown houses by now, so clear a plot for the hospital
    // the way a player would.
    world.bulldoze(idx(10, 31));
    expect(world.placeService(idx(10, 31), BuildingType.Hospital)).not.toBeNull();
    sim.services.update(world);
    // The hospital needs its lights on and its staff before it treats anybody.
    for (const b of world.buildings) b.powered = true;
    const hospital = world.buildings.find((b) => b.type === BuildingType.Hospital)!;
    hospital.occupants = world.citizens.slice(0, 6).map((c) => c.id);
    sim.services.update(world);

    for (let hour = 0; hour < 60; hour++) {
      treat(world, sim.services, sim.noise, sim.crime, sim.policies);
    }
    const withHospital = mean(world.citizens.map((c) => c.health));
    expect(withHospital).toBeGreaterThan(withoutHospital);
  });

  it('prices the environment into where health is heading', () => {
    const world = healthTown();
    const sim = new Simulation(world);
    run(sim, 600);

    const quiet = { accessRoad: idx(10, 30) };
    const covered = healthTarget(
      sim.services, sim.noise, sim.crime, sim.policies, idx(10, 31), quiet,
    );
    // No hospital reaches here, so the target is the uncovered figure less
    // whatever the street itself costs.
    expect(covered).toBeLessThanOrEqual(HEALTH_WITHOUT_HOSPITAL);
    expect(covered).toBeGreaterThan(HEALTH_WITHOUT_HOSPITAL - 10);

    // A noisy tile is worse to live on, and says so.
    const noisy = idx(11, 31);
    sim.noise.restore(loudField(noisy));
    const withNoise = healthTarget(
      sim.services, sim.noise, sim.crime, sim.policies, noisy, quiet,
    );
    expect(withNoise).toBeLessThan(covered);
  });

  it('lifts the target further when the free clinics ordinance is in force', () => {
    const world = healthTown();
    const sim = new Simulation(world);
    run(sim, 600);
    world.bulldoze(idx(10, 31));
    expect(world.placeService(idx(10, 31), BuildingType.Hospital)).not.toBeNull();
    for (const b of world.buildings) b.powered = true;
    const hospital = world.buildings.find((b) => b.type === BuildingType.Hospital)!;
    hospital.occupants = [0];
    sim.services.update(world);

    const home = { accessRoad: idx(10, 30) };
    const before = healthTarget(
      sim.services, sim.noise, sim.crime, sim.policies, idx(10, 31), home,
    );
    // Covered, so it is heading for the hospital figure rather than the bare
    // one -- less, again, whatever this particular street costs.
    expect(before).toBeGreaterThan(HEALTH_WITHOUT_HOSPITAL);
    expect(before).toBeLessThanOrEqual(HEALTH_WITH_HOSPITAL);

    sim.policies.set(Ordinance.FreeClinics, true);
    const after = healthTarget(
      sim.services, sim.noise, sim.crime, sim.policies, idx(10, 31), home,
    );
    expect(after).toBeGreaterThan(before);
  });
});

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
}

/** A noise field with one very loud tile, for the environment test. */
function loudField(tile: number): Float32Array {
  const field = new Float32Array(128 * 128);
  field[tile] = 100;
  return field;
}
