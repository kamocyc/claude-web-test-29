import { describe, expect, it } from 'vitest';
import {
  CAR_ACCEL,
  CAR_DECEL_MAX,
  CAR_FREE_SPEED,
  CAR_LENGTH,
  CAR_MIN_GAP,
} from '../config';
import { brakingSpeed, desiredSpeed, stepSpeed } from '../sim/carFollowing';

const CLEAR = Infinity;
const OPEN_ROAD = 1e6;

describe('carFollowing', () => {
  it('accelerates monotonically to free speed on an empty road', () => {
    let v = 0;
    const seen: number[] = [];
    for (let i = 0; i < 200; i++) {
      const prev = v;
      v = stepSpeed(v, desiredSpeed(CAR_FREE_SPEED, CLEAR, OPEN_ROAD), CAR_FREE_SPEED);
      expect(v).toBeGreaterThanOrEqual(prev);
      seen.push(v);
    }
    expect(v).toBeCloseTo(CAR_FREE_SPEED, 6);
    // And it takes a visible moment rather than snapping there.
    expect(seen.findIndex((s) => s >= CAR_FREE_SPEED - 1e-9)).toBeGreaterThan(10);
  });

  it('never changes speed faster than the acceleration limits', () => {
    let v = CAR_FREE_SPEED;
    for (let i = 0; i < 100; i++) {
      const next = stepSpeed(v, 0, CAR_FREE_SPEED);
      expect(next - v).toBeLessThanOrEqual(CAR_ACCEL + 1e-12);
      expect(v - next).toBeLessThanOrEqual(CAR_DECEL_MAX + 1e-12);
      v = next;
    }
    expect(v).toBe(0);
  });

  it('keeps speed at zero or above', () => {
    let v = 0;
    for (let i = 0; i < 50; i++) {
      v = stepSpeed(v, -1, CAR_FREE_SPEED);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it('stops at a stop line without overshooting it', () => {
    let v = CAR_FREE_SPEED;
    let s = 0;
    const stopAt = 4;
    for (let i = 0; i < 2000; i++) {
      v = stepSpeed(v, desiredSpeed(CAR_FREE_SPEED, CLEAR, stopAt - s), CAR_FREE_SPEED);
      s += v;
      expect(s).toBeLessThanOrEqual(stopAt + 1e-6);
    }
    expect(v).toBeLessThan(1e-6);
    // It should actually reach the line, not stall short of it.
    expect(s).toBeGreaterThan(stopAt - 0.05);
  });

  it('follows a leader without ever closing the safety gap', () => {
    // Leader brakes hard mid-way; the follower must not run into it.
    const minGap = CAR_LENGTH + CAR_MIN_GAP;
    let leaderS = 3;
    let leaderV = CAR_FREE_SPEED;
    let followS = 0;
    let followV = CAR_FREE_SPEED;

    for (let i = 0; i < 1500; i++) {
      const leaderTarget = i > 200 ? 0 : CAR_FREE_SPEED;
      leaderV = stepSpeed(leaderV, leaderTarget, CAR_FREE_SPEED);
      leaderS += leaderV;

      const gap = leaderS - followS;
      followV = stepSpeed(
        followV,
        desiredSpeed(CAR_FREE_SPEED, gap, OPEN_ROAD),
        CAR_FREE_SPEED,
      );
      followS += followV;

      expect(leaderS - followS).toBeGreaterThan(minGap * 0.5);
      expect(followS).toBeLessThan(leaderS);
    }
    // Once the leader has stopped, the follower settles just behind it.
    expect(leaderS - followS).toBeLessThan(minGap + 0.6);
  });

  it('brakingSpeed is monotonic and zero at zero distance', () => {
    expect(brakingSpeed(0)).toBe(0);
    expect(brakingSpeed(-5)).toBe(0);
    let prev = 0;
    for (let d = 0.1; d < 10; d += 0.1) {
      const v = brakingSpeed(d);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });

  it('takes the tightest of the three limits', () => {
    // A tight gap wins over an open road.
    expect(desiredSpeed(CAR_FREE_SPEED, CAR_LENGTH + CAR_MIN_GAP, OPEN_ROAD)).toBeCloseTo(0, 8);
    // A near stop line wins over a clear lane.
    expect(desiredSpeed(CAR_FREE_SPEED, CLEAR, 0)).toBe(0);
    // With everything clear, free speed is the cap.
    expect(desiredSpeed(CAR_FREE_SPEED, CLEAR, OPEN_ROAD)).toBe(CAR_FREE_SPEED);
  });
});
