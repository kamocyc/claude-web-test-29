import { describe, expect, it } from 'vitest';
import { SCHEDULE_JITTER_MINUTES, WORK_END_MINUTE, WORK_START_MINUTE } from '../config';
import { departForHomeMinute, departForWorkMinute, inDepartureWindow } from '../sim/schedule';

describe('schedule', () => {
  it('is deterministic per citizen id', () => {
    for (const id of [0, 1, 42, 1999]) {
      expect(departForWorkMinute(id)).toBe(departForWorkMinute(id));
      expect(departForHomeMinute(id)).toBe(departForHomeMinute(id));
    }
  });

  it('keeps departures inside the jitter window', () => {
    for (let id = 0; id < 500; id++) {
      const m = departForWorkMinute(id);
      expect(Math.abs(m - WORK_START_MINUTE)).toBeLessThanOrEqual(SCHEDULE_JITTER_MINUTES);
      const e = departForHomeMinute(id);
      expect(Math.abs(e - WORK_END_MINUTE)).toBeLessThanOrEqual(SCHEDULE_JITTER_MINUTES);
    }
  });

  it('spreads departures rather than bunching them on one minute', () => {
    const minutes = new Set<number>();
    for (let id = 0; id < 300; id++) minutes.add(departForWorkMinute(id));
    // A rush hour needs a spread; a single shared departure minute would make
    // the whole city leave in lockstep.
    expect(minutes.size).toBeGreaterThan(60);
  });

  it('opens the departure window for the configured span', () => {
    expect(inDepartureWindow(540, 540, 30)).toBe(true);
    expect(inDepartureWindow(560, 540, 30)).toBe(true);
    expect(inDepartureWindow(570, 540, 30)).toBe(false);
    expect(inDepartureWindow(539, 540, 30)).toBe(false);
  });

  it('handles a window that wraps past midnight', () => {
    expect(inDepartureWindow(10, 1430, 30)).toBe(true);
    expect(inDepartureWindow(1435, 1430, 30)).toBe(true);
    expect(inDepartureWindow(60, 1430, 30)).toBe(false);
  });
});
