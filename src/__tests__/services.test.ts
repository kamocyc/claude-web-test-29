import { describe, expect, it } from 'vitest';
import { EDUCATION_PER_HOUR, STARTING_EDUCATION, TICKS_PER_DAY } from '../config';
import { idx, tileX } from '../core/grid';
import { BuildingType, Terrain, Zone } from '../core/types';
import { Service } from '../sim/services';
import { Simulation } from '../sim/simulation';
import { World } from '../world/world';
import { powerTown, run } from './helpers';

/** Two housing clusters, joined only by the road the test decides to lay. */
function twoDistricts(joined: boolean): World {
  const w = new World(67);
  w.map.terrain.fill(Terrain.Grass);

  for (let x = 10; x <= 22; x++) w.placeRoad(idx(x, 20));
  for (let x = 30; x <= 42; x++) w.placeRoad(idx(x, 20));
  if (joined) {
    for (let x = 22; x <= 30; x++) w.placeRoad(idx(x, 20));
  }

  for (const x0 of [10, 30]) {
    for (let x = x0; x <= x0 + 12; x++) {
      for (const y of [19, 21]) {
        const tile = idx(x, y);
        if (w.adjacentRoad(tile) >= 0) w.paintZone(tile, Zone.ResidentialLow);
      }
    }
  }
  powerTown(w, 2);
  return w;
}

describe('civic coverage', () => {
  it('reaches along the roads, not across the map', () => {
    const world = twoDistricts(false);
    const sim = new Simulation(world);
    run(sim, 200);

    // A school in the western cluster. The eastern one is 45 tiles away in a
    // straight line and infinitely far by road, because there is no road.
    const school = world.placeService(idx(12, 21), BuildingType.School)!;
    expect(school).not.toBeNull();
    run(sim, 400);

    const homes = world.buildings.filter((b) => b.alive && b.type === BuildingType.House);
    const west = homes.filter((b) => tileX(b.tile) < 25);
    const east = homes.filter((b) => tileX(b.tile) >= 30);
    expect(west.length).toBeGreaterThan(0);
    expect(east.length).toBeGreaterThan(0);

    // Only the cluster the school can actually be driven to from is served --
    // and staffing matters, so this waits for the school to have teachers.
    run(sim, TICKS_PER_DAY);
    expect(west.some((b) => sim.services.serves(Service.School, b))).toBe(true);
    expect(east.some((b) => sim.services.serves(Service.School, b))).toBe(false);
  });

  it('follows a road built later, without anything being rebuilt', () => {
    const world = twoDistricts(false);
    const sim = new Simulation(world);
    world.placeService(idx(12, 21), BuildingType.School);
    run(sim, TICKS_PER_DAY);

    const east = world.buildings.find(
      (b) => b.alive && b.type === BuildingType.House && tileX(b.tile) >= 30,
    )!;
    expect(sim.services.serves(Service.School, east)).toBe(false);

    for (let x = 22; x <= 30; x++) world.placeRoad(idx(x, 20));
    run(sim, TICKS_PER_DAY / 4);
    expect(sim.services.serves(Service.School, east)).toBe(true);
  });

  it('teaches the households it reaches, and nobody else', () => {
    const world = twoDistricts(false);
    const sim = new Simulation(world);
    world.placeService(idx(12, 21), BuildingType.School);
    run(sim, TICKS_PER_DAY * 2);

    const taught = world.citizens.filter((c) => {
      const home = world.buildings[c.home];
      return home && sim.services.serves(Service.School, home);
    });
    const untaught = world.citizens.filter((c) => {
      const home = world.buildings[c.home];
      return home && !sim.services.serves(Service.School, home);
    });

    expect(taught.length).toBeGreaterThan(0);
    expect(untaught.length).toBeGreaterThan(0);
    // A day of school is worth EDUCATION_PER_HOUR an hour and nothing at all
    // to the district the school cannot reach.
    expect(Math.max(...taught.map((c) => c.education)))
      .toBeGreaterThan(STARTING_EDUCATION + EDUCATION_PER_HOUR * 10);
    expect(Math.max(...untaught.map((c) => c.education))).toBe(STARTING_EDUCATION);
  });

  it('counts a school with no teachers or no power as no school at all', () => {
    const world = twoDistricts(true);
    const sim = new Simulation(world);
    const school = world.placeService(idx(12, 21), BuildingType.School)!;
    run(sim, 300);

    // Brand new: nobody works there yet, so it teaches nobody.
    expect(school.occupants.length).toBe(0);
    expect(sim.services.serves(Service.School, world.buildings[school.id])).toBe(false);

    run(sim, TICKS_PER_DAY);
    expect(school.occupants.length).toBeGreaterThan(0);
    expect(sim.services.serves(Service.School, school)).toBe(true);

    // The lights go out and the catchment goes with them.
    school.powered = false;
    sim.services.update(world);
    expect(sim.services.serves(Service.School, school)).toBe(false);
  });
});

describe('crime', () => {
  it('is lower where a police station reaches than in the same city without one', () => {
    // Two runs of the identical city rather than one city before and after:
    // crime rises as a district fills up, so a "before" reading is not a
    // control -- it is a different, smaller town.
    const policed = new Simulation(twoDistricts(true));
    policed.world.placeService(idx(12, 19), BuildingType.PoliceStation);
    const unpoliced = new Simulation(twoDistricts(true));

    run(policed, TICKS_PER_DAY * 2);
    run(unpoliced, TICKS_PER_DAY * 2);

    const tile = idx(12, 21);
    expect(unpoliced.crime.at(tile)).toBeGreaterThan(0);
    expect(policed.crime.at(tile)).toBeLessThan(unpoliced.crime.at(tile));
    // And the relief is local: the far cluster gets none of it.
    const far = idx(40, 21);
    expect(policed.crime.at(far)).toBeGreaterThan(policed.crime.at(tile));
  });

  it('takes value off the land it sits on', () => {
    const world = twoDistricts(true);
    const sim = new Simulation(world);
    run(sim, TICKS_PER_DAY);

    const tile = idx(12, 21);
    const factors = sim.landValue.factorsAt(world, sim.noise, sim.crime, tile);
    expect(factors.crime).toBeLessThanOrEqual(0);
    expect(factors.target).toBeCloseTo(
      Math.min(100, Math.max(0, factors.base + factors.water + factors.greenery
        + factors.station + factors.shops + factors.offices + factors.noise + factors.crime)),
      5,
    );
  });
});
