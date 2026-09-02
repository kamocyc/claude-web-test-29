import { describe, expect, it } from 'vitest';
import { LANE_OFFSET } from '../config';
import { idx } from '../core/grid';
import { TravelMode } from '../core/types';
import { createCitizen, tileCenterX, tileCenterY } from '../sim/citizen';
import { Rng } from '../core/rng';
import { agentPose } from '../render/renderer';

/** A driver placed at the start of a two-tile route. */
function driver(from: number, to: number) {
  const c = createCitizen(0, 0, -1, from, new Rng(1));
  c.mode = TravelMode.Car;
  c.path = [from, to];
  c.x = tileCenterX(from);
  c.y = tileCenterY(from);
  c.prevX = c.x;
  c.prevY = c.y;
  return c;
}

const EAST = [idx(10, 10), idx(11, 10)] as const;
const WEST = [idx(11, 10), idx(10, 10)] as const;
const SOUTH = [idx(10, 10), idx(10, 11)] as const;

describe('drawing a car in its lane', () => {
  it('points the body along the route, not along the last frame', () => {
    // A car stopped at a red light has not moved at all, and must still face
    // the way it is going.
    expect(agentPose(driver(...EAST), 0).angle).toBeCloseTo(0);
    expect(Math.abs(agentPose(driver(...WEST), 0).angle)).toBeCloseTo(Math.PI);
    expect(agentPose(driver(...SOUTH), 0).angle).toBeCloseTo(Math.PI / 2);
  });

  it('keeps left, so the two directions never share a lane', () => {
    const east = agentPose(driver(...EAST), 0);
    const west = agentPose(driver(...WEST), 0);

    // Both are on row 10; east-bound sits north of the centre line, west-bound
    // south of it -- the same convention the occupancy model assumes.
    expect(east.y).toBeCloseTo(tileCenterY(EAST[0]) - LANE_OFFSET);
    expect(west.y).toBeCloseTo(tileCenterY(WEST[0]) + LANE_OFFSET);
    expect(east.y).toBeLessThan(west.y);
  });

  it('offsets north/south traffic the same way', () => {
    const south = agentPose(driver(...SOUTH), 0);
    expect(south.x).toBeCloseTo(tileCenterX(SOUTH[0]) + LANE_OFFSET);
  });

  it('falls back to the interpolated position when there is no route', () => {
    const c = driver(...EAST);
    c.path = null;
    c.prevX = 5;
    c.x = 5;
    c.prevY = 5;
    c.y = 5;
    const pose = agentPose(c, 0.5);
    expect(pose.x).toBeCloseTo(5);
    expect(pose.y).toBeCloseTo(5);
    expect(pose.angle).toBe(0);
  });
});
