import { beforeAll, describe, expect, it } from 'vitest';
import { TICKS_PER_DAY } from '../config';
import { CitizenState, Industry } from '../core/types';
import { cityWarnings } from '../sim/diagnostics';
import { Simulation } from '../sim/simulation';
import { industryOf } from '../world/buildings';
import { newGame } from '../world/scenario';
import { Autopilot } from './autopilot';

/**
 * Press new game, play normally, and does a town grow?
 *
 * Every other test starts from a fixture built for the thing it measures: a
 * town with one lane across the gap, a compact city that already works, a
 * crossroads with nothing on it. None of them answer the question a player
 * asks first -- and all of the parts can pass their own tests while the whole
 * thing stalls on day two, or grows into a city where nobody can get to work.
 * Both of those happened while this test was being written, which is the
 * argument for having it.
 *
 * So it starts from the *shipped* opening scenario -- the same `newGame()` the
 * app calls -- and hands it to an autopilot that does what a person does in
 * their first hour (`autopilot.ts`), through the same toolbar entry point and
 * at the same prices.
 *
 * Three sim days, on purpose. The cost of a tick is roughly the number of
 * people on the road, so a fortnight of a growing city is minutes of
 * wall-clock; three days is about ten seconds and is already a town of several
 * hundred people that has had to be powered, fed, zoned and unjammed. The run
 * is deterministic -- seeded RNG, no wall clock in the simulation, an
 * autopilot that never rolls a die -- so these thresholds are stable rather
 * than lucky.
 */
const DAYS = 3;

interface DayRecord {
  day: number;
  population: number;
  employed: number;
  buildings: number;
}

let sim: Simulation;
let pilot: Autopilot;
const history: DayRecord[] = [];

beforeAll(() => {
  sim = new Simulation(newGame());
  pilot = new Autopilot();

  for (let day = 1; day <= DAYS; day++) {
    for (let i = 0; i < TICKS_PER_DAY; i++) {
      sim.tick();
      pilot.play(sim);
    }
    history.push({
      day,
      population: sim.world.population,
      employed: sim.world.employedCount,
      buildings: sim.world.buildings.filter((b) => b.alive).length,
    });
  }
}, 300_000);

describe('a new game, played normally', () => {
  it('grows the opening town into a town of a real size', () => {
    const first = history[0];
    const last = history[history.length - 1];

    expect(last.population).toBeGreaterThan(500);
    expect(last.buildings).toBeGreaterThan(200);
    // Still growing on the last day rather than stalled at whatever the first
    // one reached: a town that fills up once and stops is not a city.
    expect(last.population).toBeGreaterThan(first.population * 2);
    expect(last.buildings).toBeGreaterThan(first.buildings * 2);
  });

  it('puts the people in it to work', () => {
    const last = history[history.length - 1];
    expect(last.employed / last.population).toBeGreaterThan(0.8);
    expect(sim.happiness.breakdown.overall).toBeGreaterThan(45);
  });

  it('keeps the lights on', () => {
    const power = sim.power.report;
    expect(power.plants).toBeGreaterThan(2);
    expect(power.offGrid).toBe(0);
    // A city this size outgrows its plants every few hours, so what matters is
    // that the shortfall is being kept marginal, not that it is never non-zero.
    expect(power.shortfall).toBeLessThan(power.demand * 0.1);
  });

  it('feeds itself', () => {
    expect(sim.chain.serviceLevel(sim.world)).toBeGreaterThan(0.6);

    const shops = sim.world.buildings.filter(
      (b) => b.alive && industryOf(b.type) === Industry.Retail,
    );
    expect(shops.length).toBeGreaterThan(4);
    expect(shops.filter((b) => b.goodsStock > 0).length).toBeGreaterThan(shops.length / 2);
    // The chain runs all the way back: somebody is digging or growing the raw
    // material the factories turn into what those shops sell.
    const primaries = sim.world.buildings.filter(
      (b) => b.alive && industryOf(b.type) === Industry.Primary,
    );
    expect(primaries.length).toBeGreaterThan(2);
  });

  it('pays for itself', () => {
    // Built out of income rather than out of an overdraft: a city that only
    // grows by borrowing has not been shown to work.
    expect(sim.economy.balance).toBeGreaterThan(0);
    expect(sim.economy.debt).toBe(0);
  });

  it('gets everybody where they are going', () => {
    const stranded = sim.world.citizens.filter((c) => c.state === CitizenState.Stranded);
    expect(stranded.length).toBeLessThan(sim.world.population * 0.01);
    // The lorries the shops depend on are moving, not parked in a junction.
    expect(sim.freight.report.stuck).toBe(0);

    const trips = sim.stats.trips();
    expect(trips.completed).toBeGreaterThan(1000);
    // And the railway the town opens with is carrying people, so the traffic
    // is bad enough to be worth avoiding but not so bad that nothing moves.
    const ridership = sim.world.activeLines.reduce((n, l) => n + l.ridership, 0);
    expect(ridership).toBeGreaterThan(10);
  });

  it('leaves nothing critical wrong with the city', () => {
    // The same list the warnings window shows the player, at the end of the
    // third day. Compared as titles so a failure says what went wrong.
    const critical = cityWarnings(sim).filter((w) => w.severity === 'critical');
    expect(critical.map((w) => w.title)).toEqual([]);
  });

  it('was built by a player doing ordinary things', () => {
    // Guards the test itself: if the autopilot stopped acting, everything
    // above would be measuring the opening town rather than a city somebody
    // built on top of it.
    expect(pilot.actions.plants).toBeGreaterThan(0);
    expect(pilot.actions.zoned).toBeGreaterThan(50);
    expect(pilot.actions.links).toBeGreaterThan(0);
  });
});
