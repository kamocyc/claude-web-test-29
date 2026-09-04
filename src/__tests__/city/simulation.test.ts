import { describe, expect, it } from 'vitest';
import { CitizenState } from '../../city/citizens';
import { seedStartingTown } from '../../city/scenario';
import { CitySimulation, SPEEDS } from '../../city/simulation';
import { CityWorld } from '../../city/world';
import { isHome, isWorkplace } from '../../city/buildings';

/**
 * The city, running on the alignment engine.
 *
 * This is the test that says the port did the thing it was for: not that the
 * geometry is pretty, but that a town laid as alignments grows buildings on
 * its plots, that people move into them, take jobs across town, and get there
 * along the lane graph in vehicles the traffic model is driving.
 */
function runningCity(seconds: number, seed = 20260903) {
  const world = new CityWorld(seed, true);
  seedStartingTown(world);
  world.rebuild();
  const sim = new CitySimulation(world, seed);
  // x30, which is what a player watching a city grow would use.
  sim.speed = SPEEDS.indexOf(30);
  // 20 frames a second of wall clock, which is what the browser gives it.
  const frames = Math.round(seconds * 20);
  for (let i = 0; i < frames; i++) sim.step(1 / 20);
  return { world, sim };
}

describe('the city on the alignment engine', () => {
  it('grows buildings on the plots the roads produced', () => {
    const { world, sim } = runningCity(60);

    // Growth is demand-driven and paced (a few buildings a sim hour), so this
    // is "the town filled in", not "every plot was covered instantly".
    expect(sim.buildings.length).toBeGreaterThan(10);
    for (const building of sim.buildings) {
      if (!building.alive) continue;
      // Every building stands on a plot, and knows the road it is entered from.
      expect(building.lot).toBeGreaterThanOrEqual(0);
      expect(world.lots[building.lot]).toBeDefined();
      expect(building.access).not.toBeNull();
      expect(world.net.segments.has(building.access!.segment)).toBe(true);
    }
    expect(sim.buildings.some(isHome)).toBe(true);
    expect(sim.buildings.some(isWorkplace)).toBe(true);
  });

  it('fills the homes and puts people into jobs', () => {
    const { sim } = runningCity(60);

    expect(sim.stats.population).toBeGreaterThan(10);
    expect(sim.stats.employed).toBeGreaterThan(0);
    // Nobody is holding a job in a building that is not there.
    for (const citizen of sim.citizens) {
      if (citizen.work < 0) continue;
      expect(sim.buildings[citizen.work]?.alive).toBe(true);
    }
    // ...and everybody lives somewhere real.
    for (const citizen of sim.citizens) {
      expect(sim.buildings[citizen.home]?.alive).toBe(true);
    }
  });

  it('sends people to work along the lane graph, in real vehicles', () => {
    const { world, sim } = runningCity(60);

    // Somebody has finished a commute, and it took a plausible time.
    const arrived = sim.citizens.filter((c) => c.lastTripMinutes > 0);
    expect(arrived.length).toBeGreaterThan(0);
    for (const citizen of arrived) {
      expect(citizen.lastTripMinutes).toBeGreaterThan(0);
      expect(citizen.lastTripMinutes).toBeLessThan(1440);
    }

    // The cars on the road are the citizens' cars: every trip vehicle belongs
    // to somebody who is travelling.
    const driving = sim.citizens.filter((c) => c.vehicle >= 0);
    for (const citizen of driving) {
      expect(world.traffic.vehicles.some((v) => v.id === citizen.vehicle)).toBe(true);
      expect([CitizenState.ToWork, CitizenState.ToHome]).toContain(citizen.state);
    }
  });

  it('leaves nobody stuck when the network changes under them', () => {
    const { world, sim } = runningCity(60);
    const before = sim.citizens.length;
    expect(before).toBeGreaterThan(0);

    // Take up a street and rebuild: plots move, the lane graph is thrown away
    // and every route into it with it.
    const victim = [...world.net.segments.values()].find(
      (s) => world.net.classOf(s).kind === 'road',
    )!;
    world.net.removeSegment(victim.id);
    world.rebuild();
    world.traffic.reset(world.laneGraph);

    for (let i = 0; i < 200; i++) sim.step(1 / 20);

    // Nobody is riding a vehicle that no longer exists, and nobody is halfway
    // along a route through a graph that has been thrown away.
    for (const citizen of sim.citizens) {
      if (citizen.vehicle >= 0) {
        expect(world.traffic.vehicles.some((v) => v.id === citizen.vehicle)).toBe(true);
      }
      expect(sim.buildings[citizen.home]?.alive ?? citizen.left).toBeTruthy();
    }
  });

  it('keeps the clock and the traffic in step at every speed', () => {
    // The ratio between "how long the drive took" and "what time it is" must
    // not change with the speed setting, or a city that works at x1 fails at
    // x10. Both come from the same multiplier, so the same wall-clock second
    // must advance the world by the same amount at every speed.
    const measure = (speed: (typeof SPEEDS)[number]): number => {
      const world = new CityWorld(20260903, true);
      seedStartingTown(world, { zones: false });
      world.rebuild();
      const sim = new CitySimulation(world, 1);
      sim.speed = SPEEDS.indexOf(speed);
      const seconds = 6;
      const from = sim.minutes;
      for (let i = 0; i < seconds * 20; i++) sim.step(1 / 20);
      // The *change* in the clock against the traffic's own time. The clock
      // does not start at zero (a city opens in the morning), so the ratio has
      // to be measured from where it started or the offset swamps it.
      return (sim.minutes - from) / world.traffic.time;
    };
    const atOne = measure(1);
    const atTen = measure(30);
    expect(atTen).toBeCloseTo(atOne, 5);
  });

  it('never puts two vehicles in the same place', () => {
    // Two separate ways this broke, both silent: a wedged car allowed to
    // ignore *crossing* traffic drove through it (car-following only ever
    // looks along the vehicle's own route, so the other one is invisible),
    // and a trip whose destination was not shifted when its route was trimmed
    // never arrived -- so cars ran off the end of their route and piled up at
    // the terminus, all at exactly the same point.
    const world = new CityWorld(20260903, true);
    seedStartingTown(world);
    world.rebuild();
    const sim = new CitySimulation(world, 20260903);
    sim.speed = SPEEDS.indexOf(30);

    let closest = Infinity;
    for (let i = 0; i < 150 * 20; i++) {
      sim.step(1 / 20);
      if (i % 100 !== 0) continue;
      const vehicles = world.traffic.vehicles;
      for (let a = 0; a < vehicles.length; a++) {
        for (let b = a + 1; b < vehicles.length; b++) {
          const pa = vehicles[a].bodies[0];
          const pb = vehicles[b].bodies[0];
          if (pa && pb) closest = Math.min(closest, pa.pos.distanceTo(pb.pos));
        }
      }
    }
    // Two cars abreast in opposite lanes of one street are about three metres
    // apart; anything under two is one driving through another.
    expect(closest).toBeGreaterThan(2);
  });

  it('drops people at the door, not at the end of the street', () => {
    const { sim } = runningCity(75);
    const arrived = sim.citizens.filter((c) => c.lastTripMinutes > 0);
    expect(arrived.length).toBeGreaterThan(0);
    for (const citizen of arrived) {
      // Whoever has finished a trip is standing in a building, not somewhere
      // down the road from it.
      const building = sim.buildings[
        citizen.state === CitizenState.AtWork ? citizen.work : citizen.home
      ];
      if (!building?.alive) continue;
      expect(citizen.at.distanceTo(building.at)).toBeLessThan(1);
    }
  });
});