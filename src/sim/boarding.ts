import { CitizenState, type CitizenId, type LineId } from '../core/types';
import { hasRoom, type TransitLine } from '../world/transit';
import type { World } from '../world/world';
import { tileCenterX, tileCenterY, type Citizen } from './citizen';

/**
 * The part of a train and a bus that is the same thing: a box with a list of
 * people in it, working its way round a line.
 *
 * Boarding used to live inside `trains.ts`, which was fine while trains were
 * the only way to ride. Written twice -- once for rail, once for road -- it
 * would have been two chances to get "does this vehicle actually reach the
 * stop I want before it turns round?" wrong, and a rider stuck on the wrong
 * one is invisible until somebody notices the ridership figures are nonsense.
 * So it is written once, over the fields both vehicles genuinely share.
 */
export interface TransitVehicle {
  id: number;
  line: LineId;
  /** Index into `line.stopAt` of the stop being approached. */
  nextStop: number;
  passengers: CitizenId[];
  x: number;
  y: number;
  prevX: number;
  prevY: number;
}

/**
 * Call at a stop: let everybody off who wanted this one, then take on anybody
 * waiting for a service that goes where they are going.
 */
export function serveStop(
  world: World,
  line: TransitLine,
  vehicle: TransitVehicle,
  station: number,
  tick: number,
): void {
  alight(world, line, vehicle, station);
  board(world, line, vehicle, station, tick);
}

function alight(
  world: World,
  line: TransitLine,
  vehicle: TransitVehicle,
  station: number,
): void {
  const staying: CitizenId[] = [];
  for (const id of vehicle.passengers) {
    const c = world.citizens[id];
    if (!c) continue;
    if (c.ride && c.ride.alightStation === station) {
      dropOff(world, c, station);
      line.ridership++;
    } else {
      staying.push(id);
    }
  }
  vehicle.passengers = staying;
}

function dropOff(world: World, c: Citizen, station: number): void {
  const stop = world.buildings[station];
  c.ride = null;
  c.boardedVehicle = -1;
  // Back on foot for the last leg, which was planned when the trip started.
  c.path = c.legAfterRide;
  c.legAfterRide = null;
  c.s = 0;
  c.v = 0;
  // Back to whichever journey this was; the ride was only ever the middle of it.
  c.state = c.legState;
  if (stop) {
    c.x = tileCenterX(stop.tile);
    c.y = tileCenterY(stop.tile);
    c.prevX = c.x;
    c.prevY = c.y;
  }
}

function board(
  world: World,
  line: TransitLine,
  vehicle: TransitVehicle,
  station: number,
  tick: number,
): void {
  for (const c of world.citizens) {
    if (!hasRoom(line, vehicle.passengers.length)) return;
    if (c.state !== CitizenState.Waiting || !c.ride) continue;
    if (c.ride.line !== line.id || c.ride.boardStation !== station) continue;
    // Only board a vehicle that will actually reach the alighting stop before
    // turning back; on an out-and-back route the wrong direction arrives first.
    if (!servesFrom(line, vehicle.nextStop, c.ride.alightStop)) continue;

    vehicle.passengers.push(c.id);
    c.boardedVehicle = vehicle.id;
    c.state = CitizenState.Riding;
    c.lastWaitTicks = Math.max(0, tick - c.waitStartTick);
    c.waitStartTick = 0;
  }
}

/**
 * Whether a vehicle currently at stop index `at` reaches `target` before it
 * comes back round to `at` again.
 */
export function servesFrom(line: TransitLine, at: number, target: number): boolean {
  const n = line.stopAt.length;
  for (let i = 1; i <= n; i++) {
    if ((at + i) % n === target) return true;
  }
  return false;
}

/** Riders are carried by the vehicle, so their position is simply its position. */
export function carryPassengers(world: World, vehicle: TransitVehicle): void {
  for (const id of vehicle.passengers) {
    const c = world.citizens[id];
    if (!c) continue;
    c.prevX = c.x;
    c.prevY = c.y;
    c.x = vehicle.x;
    c.y = vehicle.y;
  }
}
