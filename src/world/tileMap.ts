import { MAP_SIZE } from '../config';
import { idx, inBounds } from '../core/grid';
import { Terrain, Zone, type TileIndex } from '../core/types';

/**
 * Three parallel byte layers over the same 128x128 grid. Typed arrays keep the
 * whole map at 48 KB, so the renderer can scan a viewport slice per frame
 * without any allocation.
 */
export class TileMap {
  readonly size = MAP_SIZE;
  readonly terrain = new Uint8Array(MAP_SIZE * MAP_SIZE);
  readonly road = new Uint8Array(MAP_SIZE * MAP_SIZE);
  readonly zone = new Uint8Array(MAP_SIZE * MAP_SIZE);
  /** Tile -> building id, or -1. */
  readonly building = new Int32Array(MAP_SIZE * MAP_SIZE).fill(-1);

  isRoad(i: TileIndex): boolean {
    return i >= 0 && this.road[i] === 1;
  }

  isBuildable(i: TileIndex): boolean {
    return (
      i >= 0 &&
      this.terrain[i] === Terrain.Grass &&
      this.road[i] === 0 &&
      this.building[i] === -1
    );
  }

  getZone(i: TileIndex): Zone {
    return this.zone[i] as Zone;
  }

  at(x: number, y: number): TileIndex {
    return inBounds(x, y) ? idx(x, y) : -1;
  }
}
