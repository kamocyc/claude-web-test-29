import { describe, expect, it } from 'vitest';
import {
  LEISURE_TRIGGER,
  LEISURE_VISITS_PER_CAPACITY,
  LEISURE_WINDOW_MINUTES,
  TICKS_PER_DAY,
} from '../config';
import { idx } from '../core/grid';
import { BuildingType, CitizenState, Zone } from '../core/types';
import {
  chooseVenue,
  drainLeisure,
  endLeisureDay,
  leisureReport,
  visit,
} from '../sim/leisure';
import { inDepartureWindow, isRestDay, leisureMinute, restDay } from '../sim/schedule';
import { Simulation } from '../sim/simulation';
import { leisureCapacity } from '../world/buildings';
import { World } from '../world/world';
import { flatten, powerTown, run } from './helpers';

/**
 * A street of housing with somewhere to go at one end.
 *
 * Deliberately laid out so the venue is a real journey rather than next door:
 * what is being tested is that people *travel* for their leisure, and a park
 * on the doorstep would pass whether or not the trip ever happened.
 */
function leisureTown(venue: BuildingType | null): World {
  const w = new World(61);
  w.map.terrain.fill(0);
  flatten(w);

  const y = 30;
  for (const row of [y, y + 4]) {
    for (let x = 6; x <= 50; x++) w.placeRoad(idx(x, row));
  }
  for (const x of [6, 20, 36, 50]) {
    for (let k = y; k <= y + 4; k++) w.placeRoad(idx(x, k));
  }

  for (const row of [y - 1, y + 5]) {
    for (let x = 6; x <= 22; x++) {
      const tile = idx(x, row);
      if (w.adjacentRoad(tile) >= 0) w.paintZone(tile, Zone.ResidentialLow);
    }
    for (let x = 34; x <= 50; x++) {
      const tile = idx(x, row);
      if (w.adjacentRoad(tile) >= 0) w.paintZone(tile, Zone.Commercial);
    }
  }

  powerTown(w, 3);
  if (venue !== null) w.placeService(idx(30, y + 1), venue);
  return w;
}

describe('parks and leisure', () => {
  it('sends people out to a venue and brings them home again', () => {
    const world = leisureTown(BuildingType.Park);
    const sim = new Simulation(world);
    // A day and a half: long enough for people to move in and for the
    // recreation stock to drain past the trigger, and stopping in the
    // afternoon rather than at midnight -- the visit counter is cleared with
    // the day's books, so a whole number of days would read zero however
    // busy the park had been.
    run(sim, TICKS_PER_DAY * 1.5);

    expect(world.citizens.length).toBeGreaterThan(0);
    const park = world.buildings.find((b) => b.type === BuildingType.Park)!;
    expect(park.visitsToday).toBeGreaterThan(0);

    // Somebody has actually been: the stock is above what a fresh arrival has.
    const been = world.citizens.filter((c) => c.leisure > LEISURE_TRIGGER * 1.5);
    expect(been.length).toBeGreaterThan(0);
    // And nobody is stuck at the venue: they go home afterwards.
    run(sim, TICKS_PER_DAY / 2);
    const stuck = world.citizens.filter(
      (c) => c.state === CitizenState.AtLeisure && sim.clock.tick > c.retryAtTick + 2000,
    );
    expect(stuck).toHaveLength(0);
  });

  it('leaves a city with nowhere to go dissatisfied rather than travelling', () => {
    const world = leisureTown(null);
    const sim = new Simulation(world);
    run(sim, TICKS_PER_DAY * 2);

    expect(world.citizens.length).toBeGreaterThan(0);
    for (const c of world.citizens) {
      expect(c.state).not.toBe(CitizenState.AtLeisure);
      expect(c.state).not.toBe(CitizenState.ToLeisure);
    }
    expect(sim.happiness.breakdown.leisure).toBeLessThan(60);
    expect(leisureReport(world).visitsToday).toBe(0);
  });

  it('does not send anybody to a venue that is not running yet', () => {
    const world = leisureTown(BuildingType.Park);
    const sim = new Simulation(world);
    run(sim, 2000);

    const c = world.citizens[0];
    expect(c).toBeDefined();
    const park = world.buildings.find((b) => b.type === BuildingType.Park)!;
    expect(chooseVenue(world, c)).toBe(park.id);

    // A fairground with no electricity is a building site, not a day out --
    // the same test the schools and the fire stations answer to.
    const fair = world.placeService(idx(48, 31), BuildingType.AmusementPark)!;
    expect(fair).not.toBeNull();
    fair.powered = false;
    expect(chooseVenue(world, c)).toBe(park.id);

    // Turn the lights on and staff it, and it pulls -- from right across the
    // map, which a park never does.
    fair.powered = true;
    fair.occupants = world.citizens.slice(0, 4).map((p) => p.id);
    park.powered = false;
    expect(chooseVenue(world, c)).toBe(fair.id);
  });

  it('turns visitors away once a venue is full for the day', () => {
    const world = leisureTown(BuildingType.Park);
    const sim = new Simulation(world);
    run(sim, 2000);

    const park = world.buildings.find((b) => b.type === BuildingType.Park)!;
    const c = world.citizens[0];
    park.visitsToday = leisureCapacity(BuildingType.Park) * LEISURE_VISITS_PER_CAPACITY;

    expect(chooseVenue(world, c)).toBe(-1);
    expect(visit(park, c)).toBe(0);
    expect(c.lastOutingFailed).toBe(true);

    // The day's books clear the counter, and the park is worth visiting again.
    endLeisureDay(world);
    expect(park.visitsToday).toBe(0);
    expect(chooseVenue(world, c)).toBe(park.id);
  });

  it('refills the stock on a visit and drains it over the following days', () => {
    const world = leisureTown(BuildingType.Park);
    const sim = new Simulation(world);
    run(sim, 2000);

    const park = world.buildings.find((b) => b.type === BuildingType.Park)!;
    const c = world.citizens[0];
    c.leisure = 0;

    expect(visit(park, c)).toBeGreaterThan(0);
    const afterVisit = c.leisure;
    expect(afterVisit).toBeGreaterThan(LEISURE_TRIGGER);

    // A day of hours takes it back down: leisure is a stock, not a flag.
    for (let hour = 0; hour < 24; hour++) drainLeisure(world);
    expect(c.leisure).toBeLessThan(afterVisit);
  });

  it('gives everybody a rest day, staggered across the week', () => {
    const world = leisureTown(BuildingType.Park);
    const sim = new Simulation(world);
    run(sim, TICKS_PER_DAY);
    expect(world.citizens.length).toBeGreaterThan(6);

    const days = new Set(world.citizens.map((c) => restDay(c.seed)));
    // Not everybody is off on the same day -- which is the entire reason the
    // rest day is derived from the seed rather than shared.
    expect(days.size).toBeGreaterThan(1);
    for (const c of world.citizens) {
      expect(restDay(c.seed)).toBeGreaterThanOrEqual(0);
      expect(restDay(c.seed)).toBeLessThan(7);
      // The same citizen is off on the same weekday every week.
      expect(isRestDay(c.seed, restDay(c.seed))).toBe(true);
      expect(isRestDay(c.seed, restDay(c.seed) + 7)).toBe(true);
    }
  });

  it('keeps somebody at home on their day off instead of sending them to work', () => {
    const world = leisureTown(BuildingType.Park);
    const sim = new Simulation(world);
    run(sim, TICKS_PER_DAY);

    const employed = world.citizens.filter((c) => c.work >= 0);
    expect(employed.length).toBeGreaterThan(0);

    // Run a full week and count, per day, how many of the workforce were seen
    // at their desk. Somebody is always off, so the count is never everybody.
    let sawResting = false;
    for (let day = 0; day < 7 && !sawResting; day++) {
      run(sim, TICKS_PER_DAY);
      sawResting = world.citizens.some(
        (c) => c.work >= 0
          && isRestDay(c.seed, sim.clock.day)
          && c.state !== CitizenState.AtWork,
      );
    }
    expect(sawResting).toBe(true);
  });

  it('gives up for a few hours when there is nowhere to go', () => {
    const world = leisureTown(null);
    const sim = new Simulation(world);
    run(sim, TICKS_PER_DAY * 1.5);
    expect(world.citizens.length).toBeGreaterThan(0);

    // Anybody who could have asked this tick -- at home, out of recreation,
    // and inside their own window -- has already given up for a while.
    // Without that they would ask again next tick, and the search reads every
    // building in the city: a town that has not built a park yet would have
    // every household scanning the whole town sixteen times a second.
    const minute = sim.clock.minuteOfDay;
    const eligible = world.citizens.filter(
      (c) => c.state === CitizenState.AtHome
        && c.leisure <= LEISURE_TRIGGER
        && (isRestDay(c.seed, sim.clock.day)
          || inDepartureWindow(minute, leisureMinute(c.seed), LEISURE_WINDOW_MINUTES)),
    );
    expect(eligible.length).toBeGreaterThan(0);
    for (const c of eligible) expect(c.nextLeisureTick).toBeGreaterThan(sim.clock.tick);
  });

  it('brings people home when the venue is bulldozed under them', () => {
    const world = leisureTown(BuildingType.Park);
    const sim = new Simulation(world);
    run(sim, TICKS_PER_DAY * 1.4);

    const park = world.buildings.find((b) => b.type === BuildingType.Park)!;
    const out = world.citizens.filter(
      (c) => c.state === CitizenState.ToLeisure || c.state === CitizenState.AtLeisure,
    );
    expect(out.length).toBeGreaterThan(0);

    // The one thing that must not happen is somebody left travelling to, or
    // standing inside, a building that no longer exists.
    world.bulldoze(park.tile);
    run(sim, 3000);
    for (const c of world.citizens) {
      expect(c.state).not.toBe(CitizenState.ToLeisure);
      expect(c.state).not.toBe(CitizenState.AtLeisure);
      expect(c.state).not.toBe(CitizenState.Stranded);
    }
  });

  it('counts a park as a land value amenity for the ground around it', () => {
    const world = leisureTown(null);
    const sim = new Simulation(world);
    run(sim, 2000);

    const tile = idx(29, 31);
    const before = sim.landValue.factorsAt(world, sim.noise, sim.crime, tile);
    expect(before.parks).toBe(0);

    world.placeService(idx(30, 31), BuildingType.Park);
    const after = sim.landValue.factorsAt(world, sim.noise, sim.crime, tile);
    expect(after.parks).toBeGreaterThan(0);
    expect(after.target).toBeGreaterThan(before.target);

    // The breakdown is the model, not a second opinion: the terms still add
    // up to where the tile is heading.
    const sum = after.base + after.water + after.greenery + after.view
      + after.station + after.shops + after.offices + after.parks
      + after.noise + after.crime;
    expect(after.target).toBeCloseTo(Math.min(100, Math.max(0, sum)), 5);
  });
});
