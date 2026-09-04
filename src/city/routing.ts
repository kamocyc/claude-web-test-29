import type { Vector3 } from 'three';
import type { SegmentId } from '../track/network/network';
import type { LaneGraph, VehicleKind } from '../track/sim/lanegraph';

/**
 * Finding a way through the city.
 *
 * The tile city ran A* over tiles, where "next to" meant "shares an edge".
 * Here the graph is the engine's own **lane graph**: one node per lane, one
 * edge per legal movement, so a route already knows which side of the road it
 * is on, which turn it takes at a junction, and whether that turn exists at
 * all. Nothing in this file knows what a road looks like -- that is the point
 * of the lane graph -- and nothing else in the city has to know what a lane is.
 *
 * Cost is **time**, not distance: a lane's length divided by its speed limit.
 * A motorway that goes the long way round is the right answer, and with
 * distance as the cost it never would be.
 */

export interface LaneRoute {
  /** The lanes to drive, in order. */
  lanes: number[];
  /**
   * How far along the first lane the trip starts [m].
   *
   * A car has to appear at the door it is leaving from, not at the top of the
   * street: put every car on the same spot and only one of them fits, and the
   * rest of the road's households queue for a kerb that is never free.
   */
  startS: number;
  /** Seconds the route is expected to take at free flow. */
  seconds: number;
  /** Metres. */
  length: number;
}

export interface RouteRequest {
  /** Lanes the trip may start on, with how far along each one it begins. */
  from: ReadonlyArray<{ lane: number; s: number }>;
  /** Lanes the trip may end on, with how far along each one it ends. */
  to: ReadonlyArray<{ lane: number; s: number }>;
  kind?: VehicleKind;
  /** Give up after this many lanes are settled. Keeps a hopeless search cheap. */
  limit?: number;
}

/**
 * The cheapest way from any of `from` to any of `to`.
 *
 * Multi-source and multi-target on purpose: a building stands beside a road,
 * not on a lane, so "leaving home" means "join whichever lane of that road
 * goes somewhere useful" -- and deciding which one before searching would be
 * guessing at the answer the search exists to find.
 */
export function findLaneRoute(graph: LaneGraph, request: RouteRequest): LaneRoute | null {
  const { from, to } = request;
  if (from.length === 0 || to.length === 0) return null;

  const targets = new Map<number, number>();
  for (const target of to) targets.set(target.lane, target.s);

  const limit = request.limit ?? 6000;
  /** Where on each starting lane the trip would begin. */
  const startAt = new Map<number, number>();
  for (const start of from) startAt.set(start.lane, start.s);
  const best = new Map<number, number>();
  const cameFrom = new Map<number, number>();
  /** Lane -> seconds from the start of that lane's path. */
  const queue: Array<{ lane: number; cost: number }> = [];

  for (const start of from) {
    const lane = graph.lanes[start.lane];
    if (!lane) continue;
    if (request.kind && lane.vehicleKind !== request.kind) continue;
    // Starting part-way along a lane: only the rest of it is paid for.
    const rest = Math.max(0, lane.path.length - start.s);
    const cost = rest / Math.max(1, lane.speedLimit);
    if (targets.has(start.lane) && (targets.get(start.lane) ?? 0) >= start.s) {
      // Origin and destination on the same lane, the right way round.
      const span = (targets.get(start.lane) ?? 0) - start.s;
      return {
        lanes: [start.lane],
        startS: start.s,
        seconds: span / Math.max(1, lane.speedLimit),
        length: span,
      };
    }
    if ((best.get(start.lane) ?? Infinity) <= cost) continue;
    best.set(start.lane, cost);
    queue.push({ lane: start.lane, cost });
  }

  let settled = 0;
  while (queue.length > 0 && settled < limit) {
    // A small graph and a hot path: a linear scan beats a heap here, and it
    // is the same choice the engine's own route search makes.
    let at = 0;
    for (let i = 1; i < queue.length; i++) if (queue[i].cost < queue[at].cost) at = i;
    const current = queue[at];
    queue[at] = queue[queue.length - 1];
    queue.pop();
    if (current.cost > (best.get(current.lane) ?? Infinity)) continue;
    settled++;

    if (targets.has(current.lane) && cameFrom.has(current.lane)) {
      return rebuild(graph, cameFrom, current.lane, targets.get(current.lane) ?? 0, startAt);
    }

    const lane = graph.lanes[current.lane];
    if (!lane) continue;
    for (const next of lane.next) {
      const target = graph.lanes[next];
      if (!target) continue;
      if (request.kind && target.vehicleKind !== request.kind) continue;
      const cost = current.cost + target.path.length / Math.max(1, target.speedLimit);
      if (cost >= (best.get(next) ?? Infinity)) continue;
      best.set(next, cost);
      cameFrom.set(next, current.lane);
      queue.push({ lane: next, cost });
    }
  }
  return null;
}

function rebuild(
  graph: LaneGraph,
  cameFrom: Map<number, number>,
  end: number,
  endS: number,
  startAt: Map<number, number>,
): LaneRoute {
  const lanes: number[] = [end];
  let at = end;
  for (let guard = 0; guard < 4000; guard++) {
    const previous = cameFrom.get(at);
    if (previous === undefined) break;
    lanes.push(previous);
    at = previous;
  }
  lanes.reverse();

  const startS = startAt.get(lanes[0]) ?? 0;
  let length = 0;
  let seconds = 0;
  lanes.forEach((id, i) => {
    const lane = graph.lanes[id];
    if (!lane) return;
    const from = i === 0 ? startS : 0;
    const to = i === lanes.length - 1 ? endS : lane.path.length;
    const span = Math.max(0, to - from);
    length += span;
    seconds += span / Math.max(1, lane.speedLimit);
  });
  return { lanes, startS, seconds, length };
}

/** Every lane that runs along a given segment, either way. */
export function lanesOnSegment(graph: LaneGraph, segment: SegmentId): number[] {
  const out: number[] = [];
  for (const lane of graph.lanes) {
    if (lane.segment === segment && lane.kind === 'segment') out.push(lane.id);
  }
  return out;
}

/**
 * Where on a segment's lanes a point beside the road is.
 *
 * A building knows the segment it is entered from and how far along it; this
 * turns that into the handful of (lane, offset) pairs a trip can start or end
 * at. The offset is found by sampling rather than by inverting the lane's
 * geometry: lanes are parallel to their segment but not identical to it
 * (they are offset, and a junction lane is a curve of its own), so the arc
 * length that matters is the lane's, not the alignment's.
 */
export function laneStopsNear(
  graph: LaneGraph,
  segment: SegmentId,
  at: Vector3,
  kind: VehicleKind = 'car',
): Array<{ lane: number; s: number }> {
  const out: Array<{ lane: number; s: number }> = [];
  for (const id of lanesOnSegment(graph, segment)) {
    const lane = graph.lanes[id];
    if (!lane || lane.vehicleKind !== kind) continue;
    out.push({ lane: id, s: nearestOn(lane.path, at) });
  }
  return out;
}

/** The arc length along a lane path closest to a point, by coarse search. */
export function nearestOn(
  path: { length: number; poseAt(s: number): { pos: Vector3 } },
  at: Vector3,
): number {
  let bestS = 0;
  let bestDistance = Infinity;
  const coarse = Math.max(2, Math.ceil(path.length / 8));
  for (let i = 0; i <= coarse; i++) {
    const s = (path.length * i) / coarse;
    const p = path.poseAt(s).pos;
    const d = (p.x - at.x) ** 2 + (p.z - at.z) ** 2;
    if (d < bestDistance) {
      bestDistance = d;
      bestS = s;
    }
  }
  // One refinement pass, so the answer is good to a metre or so.
  const step = path.length / coarse;
  for (let i = -4; i <= 4; i++) {
    const s = Math.max(0, Math.min(path.length, bestS + (step * i) / 4));
    const p = path.poseAt(s).pos;
    const d = (p.x - at.x) ** 2 + (p.z - at.z) ** 2;
    if (d < bestDistance) {
      bestDistance = d;
      bestS = s;
    }
  }
  return bestS;
}
