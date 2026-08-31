import {
  MAX_TICKS_PER_FRAME,
  SIM_SECONDS_PER_TICK,
  SPEED_MULTIPLIERS,
  TICK_HZ,
  DEFAULT_SPEED_INDEX,
} from '../config';

const TICK_DURATION = 1 / TICK_HZ;

/**
 * Fixed-timestep accumulator. The renderer reads `alpha` to interpolate agent
 * positions between ticks -- at the x0.25 observation speed ticks arrive at
 * only 4 Hz, so without interpolation following a single citizen would stutter.
 */
export class Clock {
  /** Ticks elapsed since the start of the simulation. */
  tick = 0;
  speedIndex = DEFAULT_SPEED_INDEX;

  private accumulator = 0;

  get speed(): number {
    return SPEED_MULTIPLIERS[this.speedIndex];
  }

  get paused(): boolean {
    return this.speed === 0;
  }

  /** Fraction of the way to the next tick, for render interpolation. */
  get alpha(): number {
    return this.paused ? 0 : Math.min(1, this.accumulator / TICK_DURATION);
  }

  get simSeconds(): number {
    return this.tick * SIM_SECONDS_PER_TICK;
  }

  get day(): number {
    return Math.floor(this.simSeconds / 86_400);
  }

  /** Sim minutes past midnight, [0, 1440). */
  get minuteOfDay(): number {
    return Math.floor((this.simSeconds % 86_400) / 60);
  }

  get hour(): number {
    return Math.floor(this.minuteOfDay / 60);
  }

  get minute(): number {
    return this.minuteOfDay % 60;
  }

  format(): string {
    const h = String(this.hour).padStart(2, '0');
    const m = String(this.minute).padStart(2, '0');
    return `Day ${this.day + 1}  ${h}:${m}`;
  }

  /**
   * Consume `dtSeconds` of real time and report how many sim ticks are owed.
   * Capped at MAX_TICKS_PER_FRAME; leftover accumulator is dropped so a
   * stalled frame cannot snowball into an ever-growing backlog.
   *
   * This only counts ticks -- `step()` is what actually moves the clock, and
   * the simulation calls it once per tick. Advancing the clock here instead
   * would make every tick in a frame observe the same timestamp, so a
   * fast-forwarded frame could skip a departure window entirely.
   */
  advance(dtSeconds: number): number {
    if (this.paused) return 0;
    this.accumulator += dtSeconds * this.speed;

    let ticks = 0;
    while (this.accumulator >= TICK_DURATION && ticks < MAX_TICKS_PER_FRAME) {
      this.accumulator -= TICK_DURATION;
      ticks++;
    }
    if (this.accumulator >= TICK_DURATION) this.accumulator = 0;
    return ticks;
  }

  /** Move the clock forward by exactly one tick. */
  step(): void {
    this.tick++;
  }

  cycleSpeed(delta: number): void {
    const n = SPEED_MULTIPLIERS.length;
    this.speedIndex = Math.min(n - 1, Math.max(0, this.speedIndex + delta));
  }

  setSpeedIndex(i: number): void {
    this.speedIndex = Math.min(SPEED_MULTIPLIERS.length - 1, Math.max(0, i));
  }
}

/** Sim minutes -> ticks, for turning a distance/speed estimate into an ETA. */
export function minutesToTicks(minutes: number): number {
  return (minutes * 60) / SIM_SECONDS_PER_TICK;
}

export function ticksToMinutes(ticks: number): number {
  return (ticks * SIM_SECONDS_PER_TICK) / 60;
}
