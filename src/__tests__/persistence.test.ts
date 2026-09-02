import { describe, expect, it } from 'vitest';
import { idx } from '../core/grid';
import { CitizenState, Zone, type BuildingId } from '../core/types';
import { Simulation } from '../sim/simulation';
import { createLine } from '../world/lineBuilder';
import { deserialize, serialize } from '../world/persistence';
import { World } from '../world/world';

/** A town with roads, rail, stations, a line and a running population. */
function town(): World {
  const w = new World(99);
  w.map.terrain.fill(0);

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
      if (w.adjacentRoad(tile) >= 0) w.paintZone(tile, Zone.Residential);
    }
    for (let x = 75; x <= 90; x++) {
      const tile = idx(x, row);
      if (w.adjacentRoad(tile) >= 0) w.paintZone(tile, Zone.Commercial);
    }
  }
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
      expect(after.boardedTrain).toBe(c.boardedTrain);
      expect(after.ride?.alightStation).toBe(c.ride?.alightStation);
    }
    const aboard = (s: Simulation): number =>
      s.world.trains.reduce((n, t) => n + t.passengers.length, 0);
    expect(aboard(restored)).toBe(aboard(sim));
  });

  it('refuses a save written by a different version', () => {
    const sim = new Simulation(town());
    const data = serialize(sim);
    expect(() => deserialize({ ...data, version: data.version + 1 })).toThrow();
  });
});
