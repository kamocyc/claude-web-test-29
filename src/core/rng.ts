/**
 * mulberry32: small, fast, and reproducible. Determinism matters here --
 * the regression test replays N ticks from a fixed seed and compares hashes.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [0, max). */
  int(max: number): number {
    return Math.floor(this.next() * max);
  }

  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }

  /** A shuffled copy (Fisher-Yates), so the caller's array is left alone. */
  shuffled<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  getState(): number {
    return this.state;
  }

  /** Restoring a saved city has to restore the stream position with it, or
   *  growth after a load would replay the same draws the save already made. */
  setState(state: number): void {
    this.state = state >>> 0;
  }
}

/** Deterministic scalar derived from an id, for per-citizen jitter that must
 *  not depend on evaluation order. */
export function hashToUnit(id: number, salt: number): number {
  let h = Math.imul(id ^ salt, 0x27d4eb2d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}
