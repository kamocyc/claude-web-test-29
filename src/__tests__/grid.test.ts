import { describe, expect, it } from 'vitest';
import { MAP_SIZE } from '../config';
import { directionBetween, idx, inBounds, manhattan, neighbor, neighbors, tileX, tileY } from '../core/grid';
import { Direction } from '../core/types';

describe('grid', () => {
  it('round-trips coordinates through the flat index', () => {
    for (const [x, y] of [[0, 0], [1, 0], [0, 1], [63, 77], [MAP_SIZE - 1, MAP_SIZE - 1]]) {
      const i = idx(x, y);
      expect(tileX(i)).toBe(x);
      expect(tileY(i)).toBe(y);
    }
  });

  it('reports bounds correctly', () => {
    expect(inBounds(0, 0)).toBe(true);
    expect(inBounds(-1, 0)).toBe(false);
    expect(inBounds(MAP_SIZE, 0)).toBe(false);
    expect(inBounds(0, MAP_SIZE)).toBe(false);
  });

  it('clips neighbours at the map edge', () => {
    expect(neighbors(idx(0, 0))).toHaveLength(2);
    expect(neighbors(idx(MAP_SIZE - 1, MAP_SIZE - 1))).toHaveLength(2);
    expect(neighbors(idx(5, 5))).toHaveLength(4);
    expect(neighbor(idx(0, 0), Direction.North)).toBe(-1);
    expect(neighbor(idx(0, 0), Direction.South)).toBe(idx(0, 1));
  });

  it('derives the direction between adjacent tiles', () => {
    expect(directionBetween(idx(5, 5), idx(6, 5))).toBe(Direction.East);
    expect(directionBetween(idx(5, 5), idx(5, 4))).toBe(Direction.North);
    expect(directionBetween(idx(5, 5), idx(7, 5))).toBe(-1);
  });

  it('measures manhattan distance', () => {
    expect(manhattan(idx(2, 3), idx(5, 7))).toBe(7);
  });
});
