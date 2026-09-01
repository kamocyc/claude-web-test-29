import { TRAIN_DWELL_TICKS, TRAIN_FREE_SPEED } from '../config';
import { CitizenState, type CitizenId } from '../core/types';
import { trainHasRoom, type TransitLine, type Train } from '../world/transit';
import type { World } from '../world/world';
import { desiredSpeed, stepSpeed, TRAIN_PROFILE } from './carFollowing';
import { tileCenterX, tileCenterY, type Citizen } from './citizen';

/**
 * Trains run the same following model as cars, with the train profile, so they
 * pull out of a platform and ease into the next one rather than snapping
 * between speeds. Two things differ: the route wraps (it is a stored round
 * trip, so there is no direction flag), and a stop is a dwell rather than a
 * destination.
 */
export function advanceTrain(world: World, train: Train, tick: number): void {
  const line = world.lines[train.line];
  if (!line || !world.lineIsAlive(line)) return;

  const lap = line.route.length - 1;
  train.prevX = train.x;
  train.prevY = train.y;

  if (train.dwellUntil > tick) {
    train.v = 0;
    setTrainPosition(line, train);
    return;
  }

  const toStop = distanceToNextStop(line, train, lap);
  const gap = gapToTrainAhead(world, line, train, lap);

  train.v = stepSpeed(
    train.v,
    desiredSpeed(TRAIN_FREE_SPEED, gap, toStop, TRAIN_PROFILE),
    TRAIN_FREE_SPEED,
    TRAIN_PROFILE,
  );

  // Decide arrival from the distance measured *before* moving: the train has
  // arrived exactly when this tick's step would reach or pass the platform.
  // Detecting it after the fact means guessing whether a small remaining
  // distance is "just short" or "wrapped past", which is not decidable once
  // two stops sit close together.
  if (toStop <= Math.max(train.v, ARRIVAL_EPSILON)) {
    arriveAtStop(world, line, train, tick);
    setTrainPosition(line, train);
    return;
  }

  train.s += train.v;
  if (train.s >= lap) train.s -= lap;
  setTrainPosition(line, train);
}

/** Snap distance for the last sliver, so braking cannot asymptote forever. */
const ARRIVAL_EPSILON = 1e-3;

function distanceToNextStop(line: TransitLine, train: Train, lap: number): number {
  const target = line.stopAt[train.nextStop];
  const d = target - train.s;
  return d >= 0 ? d : d + lap;
}

/** The train ahead on the same line, wrapping round the route. */
function gapToTrainAhead(world: World, line: TransitLine, train: Train, lap: number): number {
  let best = Infinity;
  for (const id of line.trains) {
    if (id === train.id) continue;
    const other = world.trains[id];
    if (!other) continue;
    let d = other.s - train.s;
    if (d <= 0) d += lap;
    if (d < best) best = d;
  }
  return best;
}

function arriveAtStop(world: World, line: TransitLine, train: Train, tick: number): void {
  train.s = line.stopAt[train.nextStop];
  train.v = 0;
  train.dwellUntil = tick + TRAIN_DWELL_TICKS;

  const station = line.stopStation[train.nextStop];
  alight(world, line, train, station);
  board(world, line, train, station);

  train.nextStop = (train.nextStop + 1) % line.stopAt.length;
}

function alight(world: World, line: TransitLine, train: Train, station: number): void {
  const staying: CitizenId[] = [];
  for (const id of train.passengers) {
    const c = world.citizens[id];
    if (!c) continue;
    if (c.ride && c.ride.alightStation === station) {
      dropOff(world, c, station);
      line.ridership++;
    } else {
      staying.push(id);
    }
  }
  train.passengers = staying;
}

function dropOff(world: World, c: Citizen, station: number): void {
  const stop = world.buildings[station];
  c.ride = null;
  c.boardedTrain = -1;
  // Back on foot for the last leg, which was planned when the trip started.
  c.path = c.legAfterRide;
  c.legAfterRide = null;
  c.s = 0;
  c.v = 0;
  c.state = c.destination === c.work ? CitizenState.ToWork : CitizenState.ToHome;
  if (stop) {
    c.x = tileCenterX(stop.tile);
    c.y = tileCenterY(stop.tile);
    c.prevX = c.x;
    c.prevY = c.y;
  }
}

function board(world: World, line: TransitLine, train: Train, station: number): void {
  for (const c of world.citizens) {
    if (!trainHasRoom(train)) return;
    if (c.state !== CitizenState.Waiting || !c.ride) continue;
    if (c.ride.line !== line.id || c.ride.boardStation !== station) continue;
    // Only board a train that will actually reach the alighting stop before
    // turning back; on an out-and-back route the wrong direction arrives first.
    if (!servesFrom(line, train.nextStop, c.ride.alightStop)) continue;

    train.passengers.push(c.id);
    c.boardedTrain = train.id;
    c.state = CitizenState.Riding;
    c.waitStartTick = 0;
  }
}

/**
 * Whether a train currently at stop index `at` reaches `target` before it
 * comes back round to `at` again.
 */
function servesFrom(line: TransitLine, at: number, target: number): boolean {
  const n = line.stopAt.length;
  for (let i = 1; i <= n; i++) {
    if ((at + i) % n === target) return true;
  }
  return false;
}

export function setTrainPosition(line: TransitLine, train: Train): void {
  const seg = Math.min(line.route.length - 2, Math.floor(train.s));
  const t = train.s - seg;
  const ax = tileCenterX(line.route[seg]);
  const ay = tileCenterY(line.route[seg]);
  const bx = tileCenterX(line.route[seg + 1]);
  const by = tileCenterY(line.route[seg + 1]);
  train.x = ax + (bx - ax) * t;
  train.y = ay + (by - ay) * t;
}

/** Riders are carried by the train, so their position is simply its position. */
export function carryPassengers(world: World, train: Train): void {
  for (const id of train.passengers) {
    const c = world.citizens[id];
    if (!c) continue;
    c.prevX = c.x;
    c.prevY = c.y;
    c.x = train.x;
    c.y = train.y;
  }
}
