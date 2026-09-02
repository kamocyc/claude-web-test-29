import { describe, expect, it } from 'vitest';
import { TICKS_PER_DAY } from '../config';
import { idx } from '../core/grid';
import { CitizenState, TravelMode, Zone, type BuildingId } from '../core/types';
import { Simulation } from '../sim/simulation';
import { createLine } from '../world/lineBuilder';
import { World } from '../world/world';
import { powerTown } from './helpers';

function railTown(): World {
  const w = new World(77);
  w.map.terrain.fill(0);

  const y = 30;
  for (const row of [y, y + 4]) {
    for (let x = 6; x <= 100; x++) w.placeRoad(idx(x, row));
  }
  for (const x of [6, 16, 90, 100]) {
    for (let k = y; k <= y + 4; k++) w.placeRoad(idx(x, k));
  }
  for (let x = 8; x <= 98; x++) w.placeRail(idx(x, y + 2));

  const stations: BuildingId[] = [];
  for (const x of [10, 96]) {
    const b = w.placeStation(idx(x, y + 1));
    if (b) stations.push(b.id);
  }
  createLine(w, stations);

  for (const row of [y - 1, y + 5]) {
    for (let x = 6; x <= 16; x++) {
      const tile = idx(x, row);
      if (w.adjacentRoad(tile) >= 0) w.paintZone(tile, Zone.ResidentialLow);
    }
    for (let x = 90; x <= 100; x++) {
      const tile = idx(x, row);
      if (w.adjacentRoad(tile) >= 0) w.paintZone(tile, Zone.Commercial);
    }
  }
  powerTown(w);
  return w;
}

describe('citizen statistics', () => {
  it('counts every citizen exactly once', () => {
    const sim = new Simulation(railTown());
    for (let i = 0; i < 4000; i++) {
      sim.tick();
      const s = sim.stats.live;
      const accounted = s.atHome + s.atWork + s.travelling + s.waiting + s.riding
        + s.shopping + s.stranded;
      expect(accounted).toBe(sim.world.citizens.length);
      expect(s.population).toBe(sim.world.citizens.length);
    }
  });

  it('matches the platform counts the map badges draw', () => {
    const sim = new Simulation(railTown());
    let sawWaiting = false;

    for (let i = 0; i < TICKS_PER_DAY; i++) {
      sim.tick();
      if (sim.stats.live.waiting === 0) continue;
      sawWaiting = true;

      let fromStations = 0;
      for (const station of sim.world.stations) fromStations += sim.stats.waitingAt(station.id);
      expect(fromStations).toBe(sim.stats.live.waiting);
    }

    expect(sawWaiting).toBe(true);
  });

  it('records a trip only once it has actually finished', () => {
    const sim = new Simulation(railTown());
    let arrivals = 0;
    const previous = new Map<number, CitizenState>();

    for (let i = 0; i < TICKS_PER_DAY; i++) {
      sim.tick();
      for (const c of sim.world.citizens) {
        const was = previous.get(c.id);
        const settled = c.state === CitizenState.AtHome || c.state === CitizenState.AtWork;
        const wasTravelling = was !== undefined
          && was !== CitizenState.AtHome
          && was !== CitizenState.AtWork
          && was !== CitizenState.Stranded;
        if (settled && wasTravelling) arrivals++;
        previous.set(c.id, c.state);
      }
    }

    expect(arrivals).toBeGreaterThan(0);
    expect(sim.stats.totalCompleted).toBe(arrivals);
  });

  it('reports mode averages that only cover the modes actually used', () => {
    const sim = new Simulation(railTown());
    for (let i = 0; i < TICKS_PER_DAY; i++) sim.tick();

    const trips = sim.stats.trips();
    const window = trips.countByMode[TravelMode.Walk]
      + trips.countByMode[TravelMode.Car]
      + trips.countByMode[TravelMode.Transit];
    expect(window).toBeGreaterThan(0);
    expect(window).toBeLessThanOrEqual(trips.completed);

    for (const mode of [TravelMode.Walk, TravelMode.Car, TravelMode.Transit]) {
      // An unused mode reports nothing rather than a misleading zero average.
      if (trips.countByMode[mode] === 0) expect(trips.meanByMode[mode]).toBe(0);
      else expect(trips.meanByMode[mode]).toBeGreaterThan(0);
    }
    expect(trips.meanMinutes).toBeGreaterThan(0);
  });
});
