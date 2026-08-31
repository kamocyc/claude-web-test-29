import { describe, expect, it } from 'vitest';
import { Clock, minutesToTicks, ticksToMinutes } from '../core/clock';
import { MAX_TICKS_PER_FRAME, SPEED_MULTIPLIERS, TICK_HZ, TICKS_PER_DAY } from '../config';

describe('clock', () => {
  it('runs one day in 600 real seconds at x1', () => {
    // The whole time-scale design rests on this: 10 real minutes per sim day.
    expect(TICKS_PER_DAY / TICK_HZ).toBe(600);
  });

  it('emits a whole number of fixed ticks per elapsed second', () => {
    const c = new Clock();
    c.setSpeedIndex(SPEED_MULTIPLIERS.indexOf(1));
    expect(c.advance(1 / TICK_HZ)).toBe(1);
    expect(c.advance(0)).toBe(0);
    expect(c.advance(4 / TICK_HZ)).toBe(4);
    // advance() only counts; the simulation calls step() for each tick it runs.
    expect(c.tick).toBe(0);
    for (let i = 0; i < 5; i++) c.step();
    expect(c.tick).toBe(5);
  });

  it('never runs more than MAX_TICKS_PER_FRAME in one frame', () => {
    const c = new Clock();
    c.setSpeedIndex(SPEED_MULTIPLIERS.indexOf(10));
    expect(c.advance(5)).toBe(MAX_TICKS_PER_FRAME);
    // The backlog is discarded rather than carried, so a stall cannot spiral.
    expect(c.advance(0)).toBe(0);
  });

  it('does not advance while paused', () => {
    const c = new Clock();
    c.setSpeedIndex(0);
    expect(c.paused).toBe(true);
    expect(c.advance(10)).toBe(0);
    expect(c.tick).toBe(0);
  });

  it('scales tick output by the speed multiplier', () => {
    const fast = new Clock();
    fast.setSpeedIndex(SPEED_MULTIPLIERS.indexOf(3));
    expect(fast.advance(1 / TICK_HZ)).toBe(3);

    const slow = new Clock();
    slow.setSpeedIndex(SPEED_MULTIPLIERS.indexOf(0.25));
    expect(slow.advance(1 / TICK_HZ)).toBe(0);
    expect(slow.advance(3 / TICK_HZ)).toBe(1);
  });

  it('reports the time of day', () => {
    const c = new Clock();
    c.tick = Math.floor(TICKS_PER_DAY / 2);
    expect(c.hour).toBe(12);
    expect(c.day).toBe(0);

    c.tick = TICKS_PER_DAY;
    expect(c.day).toBe(1);
    expect(c.minuteOfDay).toBe(0);
  });

  it('converts between ticks and sim minutes', () => {
    expect(ticksToMinutes(minutesToTicks(45))).toBeCloseTo(45);
  });
});
