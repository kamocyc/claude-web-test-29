import { describe, expect, it } from 'vitest';
import { seedStartingTown } from '../../city/scenario';
import { CitySimulation, SPEEDS } from '../../city/simulation';
import { CityWorld } from '../../city/world';
import { JourneyLeg } from '../../city/transit';
import { isWorkplace } from '../../city/buildings';

/**
 * The lines, ridden.
 *
 * The point of these is that nobody is teleported: a rider is on a train the
 * traffic model is driving, at the platform the engine put on the lane, and
 * the ride ends because that train opened its doors somewhere -- not because
 * a timer said the journey was over.
 */
function town(seconds: number, options: { carOwnership?: number } = {}, seed = 20260903) {
  const world = new CityWorld(seed, true);
  seedStartingTown(world);
  world.rebuild();
  const sim = new CitySimulation(world, seed, options);
  sim.speed = SPEEDS.indexOf(30);
  for (let i = 0; i < Math.round(seconds * 20); i++) sim.step(1 / 20);
  return { world, sim };
}

/**
 * A town where nobody owns a car.
 *
 * The alternative is to grow a city big enough that driving stops being the
 * quicker option, which takes a simulated week to reach and tests the growth
 * model rather than the railway. Taking the cars away asks the question this
 * file is actually about: when somebody has to use the train, does the train
 * carry them?
 */
const CAR_FREE = { carOwnership: 0 };

/**
 * A car-free town whose people work at the other end of it.
 *
 * Left to itself the opening town gives everybody a job within a few hundred
 * metres of home -- there is a farm at the end of the street -- and a walk
 * beats the train every time. That is the right answer for a village and the
 * wrong question for this file, so the jobs are moved to the far end of the
 * line: the same thing that happens on its own once the city is big enough
 * that the near jobs are taken.
 */
function commutersAcrossTown(seconds = 200) {
  const { world, sim } = town(90, CAR_FREE);
  const stations = [...world.net.stations.values()].sort((a, b) => a.center.x - b.center.x);
  const west = stations[0];
  const east = stations[stations.length - 1];

  const far = sim.buildings.filter(
    (b) => b.alive && isWorkplace(b) && b.at.distanceTo(east.center) < 400,
  );
  expect(far.length).toBeGreaterThan(0);
  let given = 0;
  for (const citizen of sim.citizens) {
    const home = sim.buildings[citizen.home];
    if (!home?.alive || home.at.distanceTo(west.center) > 500) continue;
    const job = far[given % far.length];
    // Take the old job's seat and sit down in the new one, so the counts the
    // city keeps stay true.
    const old = sim.buildings[citizen.work];
    if (old) old.occupants = old.occupants.filter((id) => id !== citizen.id);
    citizen.work = job.id;
    job.occupants.push(citizen.id);
    given++;
  }
  expect(given).toBeGreaterThan(0);

  for (let i = 0; i < Math.round(seconds * 20); i++) sim.step(1 / 20);
  return { world, sim };
}

/** The same town, handed back before it has been run. */
function readyToCommute() {
  return commutersAcrossTown(0);
}

describe('the opening line', () => {
  it('is planned, runnable, and has trains on it', () => {
    const { world } = town(30);
    const plans = world.result?.lines ?? [];
    expect(plans.length).toBe(1);
    expect(plans[0].stops.length).toBe(2);
    expect(plans[0].runnable).toBe(true);
    // The traffic model put a train on it of its own accord.
    expect(world.traffic.vehicles.some((v) => v.line?.id === plans[0].id)).toBe(true);
  });

  it('carries people, on the trains that are actually running', () => {
    const { world, sim } = readyToCommute();

    // Checked every step rather than at the end: a journey is a few minutes
    // out of somebody's day, so a single snapshot mostly catches an empty
    // platform -- and the interesting claim is that nobody is ever aboard a
    // train that is not theirs, which is a claim about every step.
    let seen = 0;
    let ridden = 0;
    for (let i = 0; i < 200 * 20; i++) {
      sim.step(1 / 20);
      for (const citizen of sim.citizens) {
        const journey = citizen.journey;
        if (!journey) continue;
        seen++;
        expect(journey.board).not.toBe(journey.alight);
        if (journey.leg === JourneyLeg.Riding) {
          const train = world.traffic.vehicles.find((v) => v.id === citizen.vehicle);
          expect(train).toBeDefined();
          expect(train!.line?.id).toBe(journey.line);
          ridden++;
        } else {
          // Whoever is not aboard is not sitting in some other vehicle.
          expect(citizen.vehicle).toBe(-1);
        }
      }
    }
    expect(seen).toBeGreaterThan(0);
    expect(ridden).toBeGreaterThan(0);
  });

  it('gets its riders all the way to the door', () => {
    const { sim } = commutersAcrossTown(260);
    // Journeys that ran the whole chain: walk, wait, ride, walk. Nobody is
    // counted here until they are standing in the building they set out for.
    expect(sim.transitTrips).toBeGreaterThan(0);
  });

  it('sends nobody to the platform when there is no service', () => {
    const world = new CityWorld(20260903, true);
    seedStartingTown(world, { rail: false });
    world.rebuild();
    const sim = new CitySimulation(world, 20260903);
    sim.speed = SPEEDS.indexOf(30);
    for (let i = 0; i < 75 * 20; i++) sim.step(1 / 20);

    expect(world.result?.lines.length ?? 0).toBe(0);
    expect(sim.citizens.every((c) => c.journey === null)).toBe(true);
    expect(sim.stats.onTransit).toBe(0);
    // The city still works: without a railway people drive or walk.
    expect(sim.citizens.some((c) => c.lastTripMinutes > 0)).toBe(true);
  });
});
