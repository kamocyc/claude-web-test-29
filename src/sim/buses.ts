import { BUS_DWELL_TICKS, EMERGENCY_RETRY_TICKS } from '../config';
import { LineMode, type TransitLine } from '../world/transit';
import type { World } from '../world/world';
import { carryPassengers, serveStop } from './boarding';
import { BUS_ID_BASE, type Bus } from './bus';
import type { Crossings } from './crossings';
import { advanceVehicle, pathIsBroken, routeToBuilding, setPositionFromPath } from './movement';
import type { Occupancy } from './occupancy';
import type { Signals } from './signals';

/**
 * The buses, driven the way a citizen's car is driven: one leg at a time.
 *
 * A train follows a stored route and treats a stop as a dwell part way along
 * it. A bus does the opposite, and it matters: each leg of its journey is an
 * ordinary door-to-door path from where it is standing to the next stop, so
 * the existing movement code -- car following, junctions, signals, level
 * crossings, the gridlock release -- applies to it without knowing it is a
 * bus at all, and a route re-plans itself around a road the player took up
 * under it.
 *
 * The stored `line.route` is kept for drawing the service on the map and for
 * quoting journey times to the planner; it is not what the buses drive.
 */
export function stepBuses(
  world: World,
  occupancy: Occupancy,
  crossings: Crossings,
  signals: Signals,
  tick: number,
): void {
  for (const bus of world.buses) {
    if (bus.line < 0) continue;
    const line = world.lines[bus.line];
    if (!line || line.mode !== LineMode.Road || !world.lineIsAlive(line)) continue;

    if (bus.dwellUntil > tick) {
      bus.v = 0;
      continue;
    }
    if (!bus.path) {
      if (tick >= bus.resumeAtTick) departFor(world, line, bus, tick);
      continue;
    }
    if (pathIsBroken(world, bus)) {
      bus.path = null;
      bus.v = 0;
      continue;
    }
    if (advanceVehicle(world, bus, occupancy, crossings, signals, tick)) {
      arriveAtStop(world, line, bus, tick);
    }
    carryPassengers(world, bus);
  }
}

/** Publish where the buses are, so cars queue behind them like anything else. */
export function forEachDrivingBus(world: World, visit: (bus: Bus) => void): void {
  for (const bus of world.buses) {
    if (bus.line >= 0 && bus.path) visit(bus);
  }
}

/** Set off for the next stop on the line, or wait if the road is cut. */
function departFor(world: World, line: TransitLine, bus: Bus, tick: number): void {
  const stop = world.buildings[line.stopStation[bus.nextStop]];
  if (!stop || !stop.alive) {
    bus.resumeAtTick = tick + EMERGENCY_RETRY_TICKS;
    return;
  }
  world.refreshAccess(stop);
  const path = routeToBuilding(world, bus.x, bus.y, stop);
  if (!path) {
    // No way through: sit at the kerb and try again, exactly as a stranded
    // lorry does. The passengers stay aboard; they are no worse off here than
    // they would be standing at the stop.
    bus.resumeAtTick = tick + EMERGENCY_RETRY_TICKS;
    return;
  }
  bus.path = path;
  bus.s = 0;
  bus.v = 0;
  bus.blockedTicks = 0;
  bus.signalHold = -1;
  setPositionFromPath(bus);
}

function arriveAtStop(world: World, line: TransitLine, bus: Bus, tick: number): void {
  bus.path = null;
  bus.v = 0;
  bus.dwellUntil = tick + BUS_DWELL_TICKS;

  serveStop(world, line, bus, line.stopStation[bus.nextStop], tick);
  bus.nextStop = (bus.nextStop + 1) % line.stopAt.length;
}

/** The bus with this id, or undefined. Ids are offset, not array indices. */
export function busById(world: World, id: number): Bus | undefined {
  if (id < BUS_ID_BASE) return undefined;
  return world.buses[id - BUS_ID_BASE];
}
