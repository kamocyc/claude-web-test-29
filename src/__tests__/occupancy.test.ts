import { describe, expect, it } from 'vitest';
import { idx } from '../core/grid';
import { Direction } from '../core/types';
import { Occupancy } from '../sim/occupancy';

const TILE = idx(10, 10);

/** A car-sized occupant at full speed, which is what these tests are about. */
function car(id: number, dir: Direction, progress: number, speedRatio = 1) {
  return { id, dir, progress, speedRatio, size: 1 };
}

describe('occupancy', () => {
  it('finds only the car ahead in the same lane', () => {
    const occ = new Occupancy();
    occ.add(TILE, car(1, Direction.East, 0.2));
    occ.add(TILE, car(2, Direction.East, 0.7));
    occ.add(TILE, car(3, Direction.East, 0.9));

    expect(occ.gapAheadInTile(TILE, Direction.East, 0.2, 1)).toBeCloseTo(0.5);
    expect(occ.gapAheadInTile(TILE, Direction.East, 0.9, 3)).toBe(Infinity);
  });

  it('ignores oncoming traffic when looking for a leader', () => {
    const occ = new Occupancy();
    occ.add(TILE, car(1, Direction.West, 0.8));
    // A car heading the other way is in the other lane, not in front of us.
    expect(occ.gapAheadInTile(TILE, Direction.East, 0.1, 2)).toBe(Infinity);
  });

  it('counts same and crossing traffic as blocking, but not oncoming', () => {
    const occ = new Occupancy();
    occ.add(TILE, car(1, Direction.East, 0.5));
    occ.add(TILE, car(2, Direction.North, 0.5));
    occ.add(TILE, car(3, Direction.West, 0.5));

    // From the east-bound approach: the east-bound and north-bound cars block,
    // the west-bound one does not.
    expect(occ.blockingCount(TILE, Direction.East)).toBe(2);
  });

  it('clears every tile it touched', () => {
    const occ = new Occupancy();
    occ.add(TILE, car(1, Direction.East, 0.5));
    occ.add(idx(3, 3), car(2, Direction.North, 0.5));

    occ.clear();
    expect(occ.at(TILE)).toHaveLength(0);
    expect(occ.at(idx(3, 3))).toHaveLength(0);
    expect(occ.blockingCount(TILE, Direction.East)).toBe(0);
  });

  it('survives repeated clear/add cycles without leaking entries', () => {
    const occ = new Occupancy();
    for (let i = 0; i < 100; i++) {
      occ.clear();
      occ.add(TILE, car(i, Direction.East, 0.5));
    }
    expect(occ.at(TILE)).toHaveLength(1);
  });

  it('measures the distance into the next tile', () => {
    const occ = new Occupancy();
    occ.add(TILE, car(1, Direction.East, 0.3));
    expect(occ.gapIntoTile(TILE, Direction.East)).toBeCloseTo(0.3);
    // Crossing traffic is treated as sitting mid-tile.
    expect(occ.gapIntoTile(TILE, Direction.North)).toBeCloseTo(0.5);
  });
});
