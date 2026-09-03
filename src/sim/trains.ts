import { TRAIN_DWELL_TICKS, TRAIN_FREE_SPEED } from '../config';
import { type TransitLine, type Train } from '../world/transit';
import type { World } from '../world/world';
import { serveStop } from './boarding';
import { desiredSpeed, stepSpeed, TRAIN_PROFILE } from './carFollowing';
import { tileCenterX, tileCenterY } from './citizen';

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
  for (const id of line.vehicles) {
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

  serveStop(world, line, train, line.stopStation[train.nextStop], tick);
  train.nextStop = (train.nextStop + 1) % line.stopAt.length;
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
