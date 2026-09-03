import { describe, expect, it } from 'vitest';
import { TICKS_PER_DAY } from '../config';
import { idx } from '../core/grid';
import { BuildingType, CitizenState, Zone, type BuildingId } from '../core/types';
import { IncidentKind } from '../sim/emergency';
import { Simulation } from '../sim/simulation';
import { createBusLine, createLine } from '../world/lineBuilder';
import { deserialize, serialize } from '../world/persistence';
import { compactCity, flatten } from './helpers';
import { World } from '../world/world';
import { powerTown } from './helpers';

/** A town with roads, rail, stations, a line and a running population. */
function town(): World {
  const w = new World(99);
  w.map.terrain.fill(0);
  flatten(w);

  const y = 30;
  for (const row of [y, y + 4]) {
    for (let x = 10; x <= 90; x++) w.placeRoad(idx(x, row));
  }
  for (const x of [10, 20, 80, 90]) {
    for (let k = y; k <= y + 4; k++) w.placeRoad(idx(x, k));
  }
  for (let x = 12; x <= 88; x++) w.placeRail(idx(x, y + 2));

  const stations: BuildingId[] = [];
  for (const x of [15, 85]) {
    const b = w.placeStation(idx(x, y + 1));
    if (b) stations.push(b.id);
  }
  createLine(w, stations);

  for (const row of [y - 1, y + 5]) {
    for (let x = 10; x <= 25; x++) {
      const tile = idx(x, row);
      if (w.adjacentRoad(tile) >= 0) w.paintZone(tile, Zone.ResidentialLow);
    }
    for (let x = 75; x <= 90; x++) {
      const tile = idx(x, row);
      if (w.adjacentRoad(tile) >= 0) w.paintZone(tile, Zone.Commercial);
    }
  }

  // A bus route down the same corridor and the three civic services, so the
  // save format is exercised on a city that has all of them rather than on
  // the subset that existed when it was written.
  const stops: BuildingId[] = [];
  for (const x of [12, 45, 88]) {
    const stop = w.placeBusStop(idx(x, y + 3));
    if (stop) stops.push(stop.id);
  }
  createBusLine(w, stops);
  w.placeService(idx(22, y + 1), BuildingType.School);
  w.placeService(idx(24, y + 3), BuildingType.FireStation);
  w.placeService(idx(26, y + 1), BuildingType.PoliceStation);

  powerTown(w);
  return w;
}

function run(sim: Simulation, ticks: number): void {
  for (let i = 0; i < ticks; i++) sim.tick();
}

/** The state a replay has to reproduce exactly. */
function fingerprint(sim: Simulation): string {
  const parts: string[] = [String(sim.clock.tick)];
  for (const c of sim.world.citizens) {
    parts.push(`${c.state}:${c.mode}:${c.x.toFixed(4)}:${c.y.toFixed(4)}:${c.work}`);
  }
  for (const t of sim.world.trains) {
    parts.push(`T${t.s.toFixed(4)}:${t.passengers.length}`);
  }
  // Buses and emergency vehicles are road users whose position is as much
  // part of the city as a lorry's: a save that put them back somewhere else
  // would diverge within a tick.
  for (const b of sim.world.buses) {
    parts.push(`B${b.line}:${b.nextStop}:${b.s.toFixed(4)}:${b.passengers.length}`);
  }
  for (const u of sim.world.units) {
    parts.push(`U${u.state}:${u.incident}:${u.s.toFixed(4)}`);
  }
  // Lorries belong in the fingerprint for the same reason the trains do: a
  // subsystem the identity test does not look at is a subsystem the identity
  // test does not protect.
  for (const l of sim.world.lorries) {
    parts.push(`L${l.state}:${l.s.toFixed(4)}:${l.cargo.toFixed(3)}:${l.destination}`);
  }
  return parts.join('|');
}

describe('save and load', () => {
  it('round-trips a running city without changing anything', () => {
    const sim = new Simulation(town());
    run(sim, 4000);

    const restored = deserialize(JSON.parse(JSON.stringify(serialize(sim))));

    expect(restored.clock.tick).toBe(sim.clock.tick);
    expect(fingerprint(restored)).toBe(fingerprint(sim));
    expect(restored.world.buildings.length).toBe(sim.world.buildings.length);
    expect(restored.world.lines.length).toBe(sim.world.lines.length);
  });

  it('keeps the map itself, including rails and level crossings', () => {
    const sim = new Simulation(town());
    run(sim, 200);
    const restored = deserialize(serialize(sim));

    const before = sim.world.map;
    const after = restored.world.map;
    expect([...after.road]).toEqual([...before.road]);
    expect([...after.rail]).toEqual([...before.rail]);
    expect([...after.zone]).toEqual([...before.zone]);
    expect([...after.terrain]).toEqual([...before.terrain]);

    // The tile graphs are rebuilt rather than saved; they must still agree.
    for (let i = 0; i < before.road.length; i++) {
      expect(restored.world.roads.adjacency[i]).toBe(sim.world.roads.adjacency[i]);
      expect(restored.world.rails.adjacency[i]).toBe(sim.world.rails.adjacency[i]);
    }
  });

  it('continues identically from where the save was taken', () => {
    const sim = new Simulation(town());
    run(sim, 3000);

    const restored = deserialize(serialize(sim));
    run(sim, 1500);
    run(restored, 1500);

    expect(fingerprint(restored)).toBe(fingerprint(sim));
  });

  it('keeps passengers on their trains and walkers on their routes', () => {
    const sim = new Simulation(town());
    run(sim, 6000);

    const riding = sim.world.citizens.filter((c) => c.state === CitizenState.Riding);
    const restored = deserialize(serialize(sim));

    for (const c of riding) {
      const after = restored.world.citizens[c.id];
      expect(after.state).toBe(CitizenState.Riding);
      expect(after.boardedVehicle).toBe(c.boardedVehicle);
      expect(after.ride?.alightStation).toBe(c.ride?.alightStation);
    }
    const aboard = (s: Simulation): number =>
      s.world.trains.reduce((n, t) => n + t.passengers.length, 0);
    expect(aboard(restored)).toBe(aboard(sim));
  });

  it('carries the money, the stockpiles and the fields with it', () => {
    const sim = new Simulation(compactCity());
    run(sim, TICKS_PER_DAY * 2);
    sim.economy.borrow();
    sim.economy.setRate('commercial', 0.2);

    const restored = deserialize(JSON.parse(JSON.stringify(serialize(sim))));

    expect(restored.economy.balance).toBe(sim.economy.balance);
    expect(restored.economy.debt).toBe(sim.economy.debt);
    expect(restored.economy.rates).toEqual(sim.economy.rates);
    expect(restored.lastSettledDay).toBe(sim.lastSettledDay);

    // Stockpiles: a loaded city does not restart its supply chain from empty.
    // Goods riding around on a lorry count too -- they are as much part of the
    // city's stock as the ones on a shelf.
    const stock = (s: Simulation): number =>
      s.world.buildings.reduce((n, b) => n + b.goodsStock + b.rawStock, 0)
      + s.world.lorries.reduce((n, l) => n + l.cargo, 0);
    expect(stock(restored)).toBeCloseTo(stock(sim), 5);

    // Fields and wellbeing.
    for (let tile = 0; tile < 128 * 128; tile += 101) {
      expect(restored.noise.at(tile)).toBeCloseTo(sim.noise.at(tile), 3);
      expect(restored.landValue.at(tile)).toBeCloseTo(sim.landValue.at(tile), 3);
    }
    expect(restored.world.citizens.map((c) => [c.seed, Math.round(c.happiness)]))
      .toEqual(sim.world.citizens.map((c) => [c.seed, Math.round(c.happiness)]));
    expect(restored.world.nextCitizenSeed).toBe(sim.world.nextCitizenSeed);
    expect(restored.world.lorries.length).toBe(sim.world.lorries.length);
    expect(restored.lastFreightBucket).toBe(sim.lastFreightBucket);

    // The resource layer is part of the map, so primary industry still has
    // somewhere to be.
    expect([...restored.world.map.resource]).toEqual([...sim.world.map.resource]);
  });

  it('continues a full city identically, economy and all', () => {
    const sim = new Simulation(compactCity());
    run(sim, TICKS_PER_DAY * 2);

    const restored = deserialize(serialize(sim));
    run(sim, TICKS_PER_DAY);
    run(restored, TICKS_PER_DAY);

    expect(restored.world.population).toBe(sim.world.population);
    expect(restored.economy.balance).toBeCloseTo(sim.economy.balance, 6);
    expect(restored.economy.lastDay.net).toBeCloseTo(sim.economy.lastDay.net, 6);
    expect(fingerprint(restored)).toBe(fingerprint(sim));
  });

  it('carries the buses, the incidents and what people were taught', () => {
    const sim = new Simulation(town());
    run(sim, TICKS_PER_DAY);
    // A fire in progress is state a load has to keep: resuming into a city
    // where the building is quietly fine again would be a load that lied.
    const burning = sim.world.buildings.find((b) => b.alive && b.type === BuildingType.House)!;
    sim.emergency.raise(burning, IncidentKind.Fire, sim.clock.tick, 900);

    const restored = deserialize(JSON.parse(JSON.stringify(serialize(sim))));

    expect(restored.world.buses.length).toBe(sim.world.buses.length);
    expect(restored.world.buses.map((b) => b.passengers.length))
      .toEqual(sim.world.buses.map((b) => b.passengers.length));
    expect(restored.world.lines.map((l) => l.mode)).toEqual(sim.world.lines.map((l) => l.mode));
    expect(restored.world.units.length).toBe(sim.world.units.length);

    const live = restored.emergency.active;
    expect(live).toHaveLength(1);
    expect(live[0].building).toBe(burning.id);
    expect(live[0].deadlineTick).toBe(sim.emergency.active[0].deadlineTick);

    expect(restored.world.citizens.map((c) => [c.education, c.hasCar]))
      .toEqual(sim.world.citizens.map((c) => [c.education, c.hasCar]));
    for (let tile = 0; tile < 128 * 128; tile += 307) {
      expect(restored.crime.at(tile)).toBeCloseTo(sim.crime.at(tile), 3);
    }
  });

  it('refuses a save written by a different version', () => {
    const sim = new Simulation(town());
    const data = serialize(sim);
    expect(() => deserialize({ ...data, version: data.version + 1 })).toThrow();
  });
});
