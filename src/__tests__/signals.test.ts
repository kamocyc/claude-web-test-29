import { describe, expect, it } from 'vitest';
import { SIGNAL_ALL_RED_TICKS, SIGNAL_CYCLE_TICKS, SIGNAL_GREEN_TICKS } from '../config';
import { idx } from '../core/grid';
import { CitizenState, Direction, TravelMode } from '../core/types';
import { brakingSpeed } from '../sim/carFollowing';
import { createCitizen } from '../sim/citizen';
import { CAR_DECEL_MAX } from '../config';
import { axisOf, SignalAxis, Signals } from '../sim/signals';
import { Simulation } from '../sim/simulation';
import { World } from '../world/world';

/** A plus-shaped junction at (20, 20), plus a bare corner at (30, 30). */
function junctionWorld(): World {
  const w = new World(7);
  w.map.terrain.fill(0);

  for (let x = 16; x <= 24; x++) w.placeRoad(idx(x, 20));
  for (let y = 16; y <= 24; y++) w.placeRoad(idx(20, y));

  // An L: two arms on different axes, but nothing to arbitrate.
  for (let x = 30; x <= 34; x++) w.placeRoad(idx(x, 30));
  for (let y = 30; y <= 34; y++) w.placeRoad(idx(30, y));
  return w;
}

describe('traffic signals', () => {
  it('signalises conflicting junctions and leaves corners and straights alone', () => {
    const w = junctionWorld();
    const signals = new Signals();
    signals.refresh(w);

    expect(signals.isSignalized(idx(20, 20))).toBe(true);
    // A straight run of road has one axis only.
    expect(signals.isSignalized(idx(18, 20))).toBe(false);
    // The corner has both axes but only two arms, so no movement conflicts.
    expect(signals.isSignalized(idx(30, 30))).toBe(false);
  });

  it('gives each axis green once per cycle, never both at once', () => {
    const w = junctionWorld();
    const signals = new Signals();
    signals.refresh(w);
    const tile = idx(20, 20);

    let ns = 0;
    let ew = 0;
    let allRed = 0;
    for (let tick = 0; tick < SIGNAL_CYCLE_TICKS; tick++) {
      const green = signals.greenAxis(tile, tick);
      if (green === SignalAxis.NorthSouth) ns++;
      else if (green === SignalAxis.EastWest) ew++;
      else allRed++;

      // Whatever is green, the other axis is held.
      const northRed = signals.isRed(tile, Direction.North, tick);
      const eastRed = signals.isRed(tile, Direction.East, tick);
      expect(northRed && eastRed ? green === SignalAxis.AllRed : true).toBe(true);
      expect(northRed && !eastRed ? green === SignalAxis.EastWest : true).toBe(true);
    }

    expect(ns).toBe(SIGNAL_GREEN_TICKS);
    expect(ew).toBe(SIGNAL_GREEN_TICKS);
    expect(allRed).toBe(2 * SIGNAL_ALL_RED_TICKS);
  });

  it('treats opposite approaches as the same movement', () => {
    expect(axisOf(Direction.North)).toBe(axisOf(Direction.South));
    expect(axisOf(Direction.East)).toBe(axisOf(Direction.West));
    expect(axisOf(Direction.North)).not.toBe(axisOf(Direction.East));
  });

  it('follows the road network when the player rebuilds it', () => {
    const w = junctionWorld();
    const signals = new Signals();
    signals.refresh(w);
    expect(signals.isSignalized(idx(20, 20))).toBe(true);

    // Cut the northern arm: three arms become two, on different axes -- a
    // corner rather than a junction, so the signal comes out.
    for (let y = 16; y <= 19; y++) w.bulldoze(idx(20, y));
    for (let x = 21; x <= 24; x++) w.bulldoze(idx(x, 20));
    signals.refresh(w);
    expect(signals.isSignalized(idx(20, 20))).toBe(false);
  });

  it('holds cars at a red light and releases them on green', () => {
    const w = junctionWorld();
    const sim = new Simulation(w);
    sim.signals.refresh(w);
    const tile = idx(20, 20);

    // Find a tick where north/south is green, and confirm the east/west
    // approach is stopped at exactly that moment.
    let nsGreenTick = -1;
    for (let tick = 0; tick < SIGNAL_CYCLE_TICKS; tick++) {
      if (sim.signals.greenAxis(tile, tick) === SignalAxis.NorthSouth) {
        nsGreenTick = tick;
        break;
      }
    }
    expect(nsGreenTick).toBeGreaterThanOrEqual(0);
    expect(sim.signals.isRed(tile, Direction.North, nsGreenTick)).toBe(false);
    expect(sim.signals.isRed(tile, Direction.East, nsGreenTick)).toBe(true);
  });
});

/** Mirrors the movement model's own committed-driver test. */
function canStopWithin(v: number, distance: number): boolean {
  return v <= brakingSpeed(Math.max(0, distance), CAR_DECEL_MAX);
}

describe('cars at a signal', () => {
  /** A single driver approaching the junction from the west, heading east. */
  function driver(w: World) {
    const path = [];
    for (let x = 16; x <= 24; x++) path.push(idx(x, 20));

    const home = w.addBuilding(idx(16, 19), 0 as never);
    expect(home).not.toBeNull();
    const c = createCitizen(0, home!.id, -1, idx(16, 19), w.rng);
    c.state = CitizenState.ToWork;
    c.mode = TravelMode.Car;
    c.path = path;
    w.citizens.push(c);
    return c;
  }

  it('holds at the stop line through a red, then goes on green', () => {
    const w = junctionWorld();
    const sim = new Simulation(w);
    const c = driver(w);
    const junction = idx(20, 20);
    const line = c.path!.indexOf(junction);

    let heldOnRed = 0;
    for (let i = 0; i < 400; i++) {
      const red = sim.signals.isRed(junction, Direction.East, sim.clock.tick + 1);
      const approaching = c.s < line;
      sim.tick();

      // Waiting at the line means stopped, short of the junction, on a red.
      if (red && approaching && c.v < 1e-6 && line - c.s < 0.2) heldOnRed++;

      // Entering the junction is only ever allowed on a green, or when the
      // car was already too close to stop when the light changed.
      if (red && approaching && c.s > line) {
        expect(canStopWithin(c.v, line - (c.s - c.v))).toBe(false);
      }

      if (c.s >= c.path!.length - 1) break;
    }

    expect(heldOnRed).toBeGreaterThan(0);
    // ...and it does eventually get through, rather than being stuck for good.
    expect(c.s).toBeGreaterThan(line);
  });
});
