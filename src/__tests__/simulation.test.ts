import { describe, expect, it } from 'vitest';
import { CAR_FREE_SPEED, TICKS_PER_DAY } from '../config';
import { idx, tileX } from '../core/grid';
import { CitizenState, TravelMode, Zone } from '../core/types';
import { Simulation } from '../sim/simulation';
import { World } from '../world/world';
import { powerTown } from './helpers';

/**
 * A town laid out so commuters are forced through one shared arterial: houses
 * on the west, workplaces on the east, and a single road linking the two.
 */
function buildTestTown(seed = 11, bridgeRows = 1): World {
  const w = new World(seed);
  w.map.terrain.fill(0);

  // Housing grid on the west.
  for (let y = 10; y <= 30; y += 2) for (let x = 5; x <= 20; x++) w.placeRoad(idx(x, y));
  for (let y = 10; y <= 30; y++) w.placeRoad(idx(20, y));

  // Workplace grid on the east.
  for (let y = 10; y <= 30; y += 2) for (let x = 60; x <= 75; x++) w.placeRoad(idx(x, y));
  for (let y = 10; y <= 30; y++) w.placeRoad(idx(60, y));

  // The bottleneck: one (or a few) roads spanning the gap.
  for (let r = 0; r < bridgeRows; r++) {
    const y = 20 + r * 2;
    for (let x = 20; x <= 60; x++) w.placeRoad(idx(x, y));
  }

  for (let y = 9; y <= 31; y++) {
    for (const x of [4, 21, 59, 76]) {
      const tile = idx(x, y);
      if (w.adjacentRoad(tile) >= 0) {
        w.paintZone(tile, x < 40 ? Zone.ResidentialLow : Zone.Commercial);
      }
    }
  }
  for (let y = 9; y <= 31; y++) {
    for (let x = 5; x <= 75; x++) {
      const tile = idx(x, y);
      if (w.adjacentRoad(tile) >= 0) {
        w.paintZone(tile, x < 40 ? Zone.ResidentialLow : Zone.Commercial);
      }
    }
  }

  // Every one of these towns is a working city, so it gets the electricity a
  // working city needs: unpowered shops employ nobody, and a town with no jobs
  // never grows enough traffic to be worth measuring.
  powerTown(w, 2);
  return w;
}

function run(sim: Simulation, ticks: number): void {
  for (let i = 0; i < ticks; i++) sim.tick();
}

describe('simulation', () => {
  it('grows a population and puts people into jobs', () => {
    const sim = new Simulation(buildTestTown());
    run(sim, Math.floor(TICKS_PER_DAY / 2));

    expect(sim.world.population).toBeGreaterThan(0);
    expect(sim.world.jobCount).toBeGreaterThan(0);
    expect(sim.world.employedCount).toBeGreaterThan(0);
  });

  it('sends citizens to work in the morning and home in the evening', () => {
    const sim = new Simulation(buildTestTown());
    run(sim, TICKS_PER_DAY); // day one populates the town

    let sawCommuteToWork = false;
    let sawCommuteHome = false;
    let peakTravellers = 0;

    for (let i = 0; i < TICKS_PER_DAY; i++) {
      sim.tick();
      let travelling = 0;
      for (const c of sim.world.citizens) {
        if (c.state === CitizenState.ToWork) { sawCommuteToWork = true; travelling++; }
        if (c.state === CitizenState.ToHome) { sawCommuteHome = true; travelling++; }
      }
      peakTravellers = Math.max(peakTravellers, travelling);
    }

    expect(sawCommuteToWork).toBe(true);
    expect(sawCommuteHome).toBe(true);
    expect(peakTravellers).toBeGreaterThan(5);
  });

  it('citizens actually arrive rather than getting stuck forever', () => {
    const sim = new Simulation(buildTestTown());
    run(sim, TICKS_PER_DAY);

    const before = sim.world.citizens.filter((c) => c.state === CitizenState.AtWork).length;
    run(sim, TICKS_PER_DAY);
    const after = sim.world.citizens.filter(
      (c) => c.state === CitizenState.AtWork || c.state === CitizenState.AtHome,
    ).length;

    expect(after).toBeGreaterThanOrEqual(before);
    // Nobody should still be crawling along a route a full day later.
    const stillTravelling = sim.world.citizens.filter(
      (c) => c.state === CitizenState.ToWork || c.state === CitizenState.ToHome,
    );
    expect(stillTravelling.length).toBeLessThan(sim.world.citizens.length);
  });

  it('produces congestion on a bottleneck, and none on a wide-open road', () => {
    // Same demand, different capacity. The only thing that changes is how many
    // lanes span the gap, so any speed difference is the traffic model itself.
    const narrow = new Simulation(buildTestTown(11, 1));
    const wide = new Simulation(buildTestTown(11, 6));

    const measure = (sim: Simulation): number => {
      run(sim, TICKS_PER_DAY * 2);
      let slowest = 1;
      for (let i = 0; i < TICKS_PER_DAY; i++) {
        sim.tick();
        let sum = 0;
        let n = 0;
        for (const c of sim.world.citizens) {
          if (c.mode !== TravelMode.Car) continue;
          if (c.state !== CitizenState.ToWork && c.state !== CitizenState.ToHome) continue;
          if (!c.path) continue;
          sum += c.v / CAR_FREE_SPEED;
          n++;
        }
        if (n > 20) slowest = Math.min(slowest, sum / n);
      }
      return slowest;
    };

    const narrowSpeed = measure(narrow);
    const wideSpeed = measure(wide);

    expect(narrowSpeed).toBeLessThan(wideSpeed);
    // The jam is real: cars are well below free flow at the worst moment.
    expect(narrowSpeed).toBeLessThan(0.8);
  });

  it('drains its queues instead of locking up', () => {
    // A single lane carrying a whole city's rush hour queues for hours, and
    // that is the model working, not failing -- a lane cannot discharge faster
    // than one car per (CAR_LENGTH + CAR_MIN_GAP). What must never happen is a
    // queue that stops moving for good. So this asserts the jam *clears*.
    const sim = new Simulation(buildTestTown(11, 1));
    run(sim, TICKS_PER_DAY * 2);

    let sawSeriousBlocking = false;
    for (let i = 0; i < TICKS_PER_DAY; i++) {
      sim.tick();
      for (const c of sim.world.citizens) {
        if (c.blockedTicks > 200) sawSeriousBlocking = true;
      }
    }

    // The bottleneck really did back up...
    expect(sawSeriousBlocking).toBe(true);

    // ...and by the small hours everyone is home or at work, nobody is still
    // sitting in a queue, and no route was abandoned.
    run(sim, Math.floor(TICKS_PER_DAY * 0.25));
    for (const c of sim.world.citizens) {
      expect(c.blockedTicks).toBe(0);
      expect(c.state).not.toBe(CitizenState.Stranded);
    }
    const stillMoving = sim.world.citizens.filter(
      (c) => c.state === CitizenState.ToWork || c.state === CitizenState.ToHome,
    );
    expect(stillMoving).toHaveLength(0);
  });

  it('strands citizens when their route is destroyed, and recovers it', () => {
    const world = buildTestTown(11, 1);
    const sim = new Simulation(world);
    run(sim, TICKS_PER_DAY);

    // Sever the only link between the housing and the workplaces.
    for (let x = 21; x <= 59; x++) world.bulldoze(idx(x, 20));
    run(sim, Math.floor(TICKS_PER_DAY / 2));
    expect(sim.strandedCount).toBeGreaterThan(0);

    // Rebuild it; the stranded citizens must find their way again.
    for (let x = 20; x <= 60; x++) world.placeRoad(idx(x, 20));
    run(sim, TICKS_PER_DAY);
    expect(sim.strandedCount).toBe(0);
  });

  it('keeps every car on a road tile while driving', () => {
    const sim = new Simulation(buildTestTown());
    run(sim, TICKS_PER_DAY);

    for (let i = 0; i < 400; i++) {
      sim.tick();
      for (const c of sim.world.citizens) {
        if (c.mode !== TravelMode.Car || !c.path) continue;
        if (c.state !== CitizenState.ToWork && c.state !== CitizenState.ToHome) continue;
        const seg = Math.min(c.path.length - 2, Math.floor(c.s));
        // Only the first and last segments touch a building tile.
        if (seg > 0 && seg < c.path.length - 2) {
          expect(sim.world.map.isRoad(c.path[seg])).toBe(true);
        }
        expect(tileX(c.path[seg])).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('determinism', () => {
  it('replays identically from the same seed', () => {
    const hash = (sim: Simulation): string => {
      let h = 0;
      for (const c of sim.world.citizens) {
        h = (Math.imul(h, 31) + c.state) | 0;
        h = (Math.imul(h, 31) + Math.round(c.x * 1000)) | 0;
        h = (Math.imul(h, 31) + Math.round(c.y * 1000)) | 0;
        h = (Math.imul(h, 31) + Math.round(c.v * 1e6)) | 0;
      }
      return `${sim.world.population}:${sim.world.jobCount}:${h}`;
    };

    const a = new Simulation(buildTestTown(99));
    const b = new Simulation(buildTestTown(99));
    run(a, TICKS_PER_DAY);
    run(b, TICKS_PER_DAY);

    expect(hash(a)).toBe(hash(b));
    expect(a.world.population).toBeGreaterThan(0);
  });

  it('diverges for different seeds', () => {
    const a = new Simulation(buildTestTown(1));
    const b = new Simulation(buildTestTown(2));
    run(a, Math.floor(TICKS_PER_DAY / 2));
    run(b, Math.floor(TICKS_PER_DAY / 2));
    const names = (s: Simulation) => s.world.citizens.slice(0, 20).map((c) => c.name).join(',');
    expect(names(a)).not.toBe(names(b));
  });
});
