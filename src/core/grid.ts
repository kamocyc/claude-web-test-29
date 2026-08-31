import { MAP_SIZE } from '../config';
import { DIRECTIONS, type Direction, type TileIndex } from './types';

export function idx(x: number, y: number): TileIndex {
  return y * MAP_SIZE + x;
}

export function tileX(i: TileIndex): number {
  return i % MAP_SIZE;
}

export function tileY(i: TileIndex): number {
  return (i / MAP_SIZE) | 0;
}

export function inBounds(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < MAP_SIZE && y < MAP_SIZE;
}

/** Neighbour in the given direction, or -1 if it falls off the map. */
export function neighbor(i: TileIndex, dir: Direction): TileIndex {
  const d = DIRECTIONS[dir];
  const x = tileX(i) + d.dx;
  const y = tileY(i) + d.dy;
  return inBounds(x, y) ? idx(x, y) : -1;
}

/** The four in-bounds neighbours of a tile. */
export function neighbors(i: TileIndex): TileIndex[] {
  const out: TileIndex[] = [];
  for (let dir = 0; dir < 4; dir++) {
    const n = neighbor(i, dir as Direction);
    if (n >= 0) out.push(n);
  }
  return out;
}

/** Direction to step from `from` to an adjacent `to`, or -1 if not adjacent. */
export function directionBetween(from: TileIndex, to: TileIndex): Direction | -1 {
  const dx = tileX(to) - tileX(from);
  const dy = tileY(to) - tileY(from);
  for (let dir = 0; dir < 4; dir++) {
    const d = DIRECTIONS[dir];
    if (d.dx === dx && d.dy === dy) return dir as Direction;
  }
  return -1;
}

export function manhattan(a: TileIndex, b: TileIndex): number {
  return Math.abs(tileX(a) - tileX(b)) + Math.abs(tileY(a) - tileY(b));
}
