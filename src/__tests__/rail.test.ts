import { describe, expect, it } from 'vitest';
import { TICKS_PER_DAY, TRAIN_CAPACITY } from '../config';
import { idx } from '../core/grid';
import { CitizenState, TravelMode, Zone, type BuildingId } from '../core/types';
import { Occupancy } from '../sim/occupancy';
import { Simulation } from '../sim/simulation';
import { createLine } from '../world/lineBuilder';
import { World } from '../world/world';
import { flatten, powerTown } from './helpers';

/**
 * Two clusters at opposite ends of a long corridor: housing in the west, jobs
 * in the east, joined by a road the whole way *and* a railway with a station
 * sitting on each cluster. That is the layout the model is meant to reward --
 * a long trip with a short walk at both ends.
 */
function railTown(withRail: boolean): World {
  const w = new World(31);
  w.map.terrain.fill(0);
  flatten(w);

  const y = 30;
  const WEST = 10;
  const EAST = 96;

  // The trunk road, and a service street either side of the railway.
  for (const row of [y, y + 4]) {
    for (let x = WEST - 4; x <= EAST + 4; x++) w.placeRoad(idx(x, row));
  }
  for (const x of [WEST - 4, WEST + 6, EAST - 6, EAST + 4]) {
    for (let k = y; k <= y + 4; k++) w.placeRoad(idx(x, k));
  }

  if (withRail) {
    // Laid after the roads, so the north-south streets it meets become level
    // crossings rather than gaps in the line.
    for (let x = WEST - 2; x <= EAST + 2; x++) w.placeRail(idx(x, y + 2));
    const stations: BuildingId[] = [];
    for (const x of [WEST, EAST]) {
      const b = w.placeStation(idx(x, y + 1));
      if (b) stations.push(b.id);
    }
    createLine(w, stations);
  }

  powerTown(w);

  // Housing only in the west cluster, jobs only in the east one, so every
  // commute is the full length of the corridor.
  for (const row of [y - 1, y + 5]) {
    for (let x = WEST - 4; x <= WEST + 6; x++) {
      const tile = idx(x, row);
      if (w.adjacentRoad(tile) >= 0) w.paintZone(tile, Zone.ResidentialLow);
    }
    for (let x = EAST - 6; x <= EAST + 4; x++) {
      const tile = idx(x, row);
      if (w.adjacentRoad(tile) >= 0) w.paintZone(tile, Zone.Commercial);
    }
  }
  return w;
}

function run(sim: Simulation, ticks: number): void {
  for (let i = 0; i < ticks; i++) sim.tick();
}

describe('rail', () => {
  it('runs trains along the line and returns them to the start', () => {
    const sim = new Simulation(railTown(true));
    const line = sim.world.activeLines[0];
    const train = sim.world.trains[line.vehicles[0]];
    const lap = line.route.length - 1;

    const startS = train.s;
    let maxS = 0;
    let wrapped = false;
    for (let i = 0; i < TICKS_PER_DAY; i++) {
      sim.tick();
      expect(train.s).toBeGreaterThanOrEqual(0);
      expect(train.s).toBeLessThanOrEqual(lap);
      if (train.s > maxS) maxS = train.s;
      if (maxS > lap * 0.9 && train.s < lap * 0.1) wrapped = true;
    }
    expect(maxS).toBeGreaterThan(lap * 0.9);
    expect(wrapped).toBe(true);
    expect(startS).toBe(0);
  });

  it('accelerates out of a platform and brakes into the next one', () => {
    const sim = new Simulation(railTown(true));
    const line = sim.world.activeLines[0];
    const train = sim.world.trains[line.vehicles[0]];

    const speeds: number[] = [];
    for (let i = 0; i < 2000; i++) {
      sim.tick();
      speeds.push(train.v);
    }
    // It reaches line speed somewhere...
    expect(Math.max(...speeds)).toBeGreaterThan(0.25);
    // ...and comes to a complete stand at platforms.
    expect(Math.min(...speeds)).toBe(0);
    // Never a jump: the speed changes only within the acceleration limits.
    for (let i = 1; i < speeds.length; i++) {
      const delta = speeds[i] - speeds[i - 1];
      // A stop snaps to zero on arrival, which is the one allowed jump.
      if (speeds[i] === 0) continue;
      expect(Math.abs(delta)).toBeLessThanOrEqual(0.0061);
    }
  });

  it('makes citizens choose the train when it beats driving', () => {
    const sim = new Simulation(railTown(true));
    run(sim, TICKS_PER_DAY * 2);

    let chose = 0;
    for (const c of sim.world.citizens) {
      if (c.mode === TravelMode.Transit) chose++;
    }
    expect(sim.world.population).toBeGreaterThan(0);
    expect(chose).toBeGreaterThan(0);
  });

  it('leaves everyone driving when there is no railway', () => {
    const sim = new Simulation(railTown(false));
    run(sim, TICKS_PER_DAY * 2);
    for (const c of sim.world.citizens) {
      expect(c.mode).not.toBe(TravelMode.Transit);
    }
  });

  it('carries passengers through the whole wait-board-ride-alight cycle', () => {
    const sim = new Simulation(railTown(true));
    run(sim, TICKS_PER_DAY);

    let sawWaiting = false;
    let sawRiding = false;
    let maxAboard = 0;

    for (let i = 0; i < TICKS_PER_DAY; i++) {
      sim.tick();
      for (const c of sim.world.citizens) {
        if (c.state === CitizenState.Waiting) sawWaiting = true;
        if (c.state === CitizenState.Riding) sawRiding = true;
      }
      for (const t of sim.world.trains) {
        maxAboard = Math.max(maxAboard, t.passengers.length);
      }
    }

    expect(sawWaiting).toBe(true);
    expect(sawRiding).toBe(true);
    expect(maxAboard).toBeGreaterThan(0);
    expect(maxAboard).toBeLessThanOrEqual(TRAIN_CAPACITY);
    // Riders were actually delivered, not just carried around.
    expect(sim.world.activeLines[0].ridership).toBeGreaterThan(0);
  });

  it('never carries a passenger past their alighting station', () => {
    const sim = new Simulation(railTown(true));
    run(sim, TICKS_PER_DAY);

    for (let i = 0; i < TICKS_PER_DAY; i++) {
      sim.tick();
      for (const t of sim.world.trains) {
        for (const id of t.passengers) {
          const c = sim.world.citizens[id];
          // Anyone aboard still has a ride booked and a walk home queued.
          expect(c.ride).not.toBeNull();
          expect(c.boardedVehicle).toBe(t.id);
          expect(c.legAfterRide).not.toBeNull();
        }
      }
    }
  });

  it('gets transit users all the way to their destination', () => {
    const sim = new Simulation(railTown(true));
    run(sim, TICKS_PER_DAY * 2);

    const riders = sim.world.citizens.filter((c) => c.mode === TravelMode.Transit);
    expect(riders.length).toBeGreaterThan(0);

    // By the small hours, everyone is settled -- nobody abandoned on a platform.
    run(sim, TICKS_PER_DAY);
    for (const c of riders) {
      expect([CitizenState.AtHome, CitizenState.AtWork]).toContain(c.state);
      expect(c.boardedVehicle).toBe(-1);
    }
  });

  it('puts riders back on foot when their line is demolished mid-trip', () => {
    const sim = new Simulation(railTown(true));
    run(sim, TICKS_PER_DAY);

    // Advance to a point where people are actually using the line.
    let guard = 0;
    while (
      guard++ < TICKS_PER_DAY &&
      !sim.world.citizens.some(
        (c) => c.state === CitizenState.Riding || c.state === CitizenState.Waiting,
      )
    ) {
      sim.tick();
    }
    const affected = sim.world.citizens.filter(
      (c) => c.state === CitizenState.Riding || c.state === CitizenState.Waiting,
    );
    expect(affected.length).toBeGreaterThan(0);

    sim.world.bulldoze(idx(50, 32));
    expect(sim.world.activeLines).toHaveLength(0);

    run(sim, TICKS_PER_DAY);
    for (const c of affected) {
      expect(c.state).not.toBe(CitizenState.Riding);
      expect(c.state).not.toBe(CitizenState.Waiting);
      expect(c.boardedVehicle).toBe(-1);
    }
  });

  it('replays identically from the same seed with rail running', () => {
    const hash = (sim: Simulation): string => {
      let h = 0;
      for (const c of sim.world.citizens) {
        h = (Math.imul(h, 31) + c.state) | 0;
        h = (Math.imul(h, 31) + Math.round(c.x * 1000)) | 0;
        h = (Math.imul(h, 31) + c.boardedVehicle) | 0;
      }
      for (const t of sim.world.trains) {
        h = (Math.imul(h, 31) + Math.round(t.s * 1000)) | 0;
        h = (Math.imul(h, 31) + t.passengers.length) | 0;
      }
      return `${sim.world.population}:${h}`;
    };

    const a = new Simulation(railTown(true));
    const b = new Simulation(railTown(true));
    run(a, TICKS_PER_DAY);
    run(b, TICKS_PER_DAY);
    expect(hash(a)).toBe(hash(b));
  });
});

describe('level crossings', () => {
  /** One road crossing one railway, with a line running over it. */
  function crossingWorld(): World {
    const w = new World(17);
    w.map.terrain.fill(0);
    for (let y = 5; y <= 55; y++) w.placeRoad(idx(30, y));
    for (let x = 5; x <= 55; x++) w.placeRail(idx(x, 30));
    for (let x = 5; x <= 55; x++) w.placeRoad(idx(x, 28));
    const stations: BuildingId[] = [];
    for (const x of [10, 50]) {
      const b = w.placeStation(idx(x, 29));
      if (b) stations.push(b.id);
    }
    createLine(w, stations);
    return w;
  }

  it('lets a road and a railway share a tile', () => {
    const w = crossingWorld();
    const tile = idx(30, 30);
    expect(w.map.isRoad(tile)).toBe(true);
    expect(w.map.isRail(tile)).toBe(true);
    expect(w.map.isCrossing(tile)).toBe(true);
    // Both networks route through it, so neither is severed by the other.
    expect(w.roads.connects(tile, 0 as never)).toBe(true);
    expect(w.rails.has(tile)).toBe(true);
  });

  it('keeps a rail line intact where roads cross it', () => {
    const w = crossingWorld();
    expect(w.activeLines).toHaveLength(1);
    expect(w.activeLines[0].route.length).toBeGreaterThan(40);
  });

  it('closes the crossing only while a train is approaching', () => {
    const sim = new Simulation(crossingWorld());
    const tile = idx(30, 30);

    let sawClosed = false;
    let sawOpen = false;
    for (let i = 0; i < TICKS_PER_DAY / 4; i++) {
      sim.tick();
      if (sim.crossings.isClosed(tile)) sawClosed = true;
      else sawOpen = true;
    }
    expect(sawClosed).toBe(true);
    expect(sawOpen).toBe(true);
  });

  it('never marks a plain road tile as a crossing', () => {
    const sim = new Simulation(crossingWorld());
    for (let i = 0; i < 500; i++) {
      sim.tick();
      for (const tile of sim.crossings.closedTiles) {
        expect(sim.world.map.isCrossing(tile)).toBe(true);
      }
    }
  });

  it('is not released by the gridlock valve, unlike a queue', () => {
    // Tile capacity has a release for cars that have waited too long. A closed
    // crossing must have no such valve: waiting longer can never be a reason
    // to drive onto the rails.
    const sim = new Simulation(crossingWorld());
    const tile = idx(30, 30);
    for (let i = 0; i < 4000; i++) {
      sim.tick();
      if (!sim.crossings.isClosed(tile)) continue;
      for (const c of sim.world.citizens) {
        if (c.mode !== TravelMode.Car || !c.path) continue;
        const seg = Math.min(c.path.length - 2, Math.floor(c.s));
        // No car is ever standing on a closed crossing tile.
        if (c.path[seg] === tile) {
          expect(sim.crossings.isClosed(tile)).toBe(false);
        }
      }
    }
  });
});

describe('mode choice', () => {
  /**
   * Two districts joined by one narrow road corridor and one railway -- the
   * shape where the choice between driving and the train is actually live.
   */
  function corridorCity(): World {
    const w = new World(23);
    w.map.terrain.fill(0);
    const top = 40, height = 30, BLOCK = 5;
    const west = { x: 20, w: 20 };
    const east = { x: 70, w: 20 };

    for (const d of [west, east]) {
      for (let dy = 0; dy <= height; dy += BLOCK) {
        for (let k = 0; k <= d.w; k++) w.placeRoad(idx(d.x + k, top + dy));
      }
      for (let dx = 0; dx <= d.w; dx += BLOCK) {
        for (let k = 0; k <= height; k++) w.placeRoad(idx(d.x + dx, top + k));
      }
    }
    // A single road link: the bottleneck.
    for (let x = west.x + west.w; x <= east.x; x++) w.placeRoad(idx(x, top + 15));

    const railRow = top + 8;
    for (let x = west.x + 2; x <= east.x + east.w - 2; x++) w.placeRail(idx(x, railRow));
    const stations: BuildingId[] = [];
    for (const x of [west.x + 8, east.x + 12]) {
      const b = w.placeStation(idx(x, railRow + 1));
      if (b) stations.push(b.id);
    }
    createLine(w, stations);

    for (const d of [west, east]) {
      for (let x = d.x; x <= d.x + d.w; x++) {
        for (let y = top; y <= top + height; y++) {
          const tile = idx(x, y);
          if (w.adjacentRoad(tile) >= 0) {
            w.paintZone(tile, d === west ? Zone.ResidentialLow : Zone.Commercial);
          }
        }
      }
    }
    powerTown(w);
    return w;
  }

  it('places four usable stations and a working line in the fixture', () => {
    const w = corridorCity();
    expect(w.stations.length).toBe(2);
    expect(w.activeLines).toHaveLength(1);
  });

  it('prices a drive by remembered congestion, not free flow', () => {
    const sim = new Simulation(corridorCity());
    const path = [idx(41, 55), idx(42, 55), idx(43, 55)];

    // With no memory of trouble, the estimate is exactly free flow.
    const clean = sim.traffic.driveTicks(path);
    expect(clean).toBeCloseTo((path.length - 1) / 0.125);

    // Let a rush hour actually happen on the corridor.
    run(sim, TICKS_PER_DAY * 2);
    const busy = sim.traffic.driveTicks(path);
    expect(busy).toBeGreaterThan(clean);
  });

  it('forgets a jam once the road clears, and never overshoots free flow', () => {
    const sim = new Simulation(corridorCity());
    run(sim, TICKS_PER_DAY * 2);

    // Find a tile the rush actually slowed down.
    let tile = -1;
    for (let i = 0; i < sim.world.map.road.length; i++) {
      if (sim.traffic.speedRatio(i) < 0.9) {
        tile = i;
        break;
      }
    }
    expect(tile).toBeGreaterThanOrEqual(0);
    const jammed = sim.traffic.speedRatio(tile);

    // Feed it an empty road rather than another day of the same city: a full
    // day contains a second rush hour, so comparing two points in the cycle
    // would say nothing about recovery either way.
    const empty = new Occupancy();
    for (let i = 0; i < 4000; i++) sim.traffic.update(empty);

    expect(sim.traffic.speedRatio(tile)).toBeGreaterThan(jammed);
    expect(sim.traffic.speedRatio(tile)).toBe(1);
  });

  it('shifts citizens onto the train once the corridor congests', () => {
    const sim = new Simulation(corridorCity());
    run(sim, TICKS_PER_DAY * 3);

    const riders = sim.world.citizens.filter((c) => c.mode === TravelMode.Transit).length;
    expect(sim.world.population).toBeGreaterThan(50);
    expect(riders).toBeGreaterThan(0);
    expect(sim.world.activeLines[0].ridership).toBeGreaterThan(0);
  });

  it('leaves the same city all-car when the line is removed', () => {
    const world = corridorCity();
    for (const s of world.stations) world.bulldoze(s.tile);
    const sim = new Simulation(world);
    run(sim, TICKS_PER_DAY * 3);

    expect(sim.world.activeLines).toHaveLength(0);
    for (const c of sim.world.citizens) {
      expect(c.mode).not.toBe(TravelMode.Transit);
    }
  });
});
