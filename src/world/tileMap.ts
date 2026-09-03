import { CLEARANCE, MAP_SIZE, MAX_TERRAIN_HEIGHT } from '../config';
import { idx, inBounds, neighbors } from '../core/grid';
import { Resource, Terrain, Zone, type TileIndex } from '../core/types';

/**
 * Parallel byte layers over the same 128x128 grid. Typed arrays keep the whole
 * map well under a megabyte, so the renderer can scan a viewport slice per
 * frame without any allocation.
 */
export class TileMap {
  readonly size = MAP_SIZE;
  readonly terrain = new Uint8Array(MAP_SIZE * MAP_SIZE);
  readonly road = new Uint8Array(MAP_SIZE * MAP_SIZE);
  readonly rail = new Uint8Array(MAP_SIZE * MAP_SIZE);
  readonly zone = new Uint8Array(MAP_SIZE * MAP_SIZE);
  /** What the ground is good for. Primary industry is tied to this layer. */
  readonly resource = new Uint8Array(MAP_SIZE * MAP_SIZE);
  /** Tile -> building id, or -1. */
  readonly building = new Int32Array(MAP_SIZE * MAP_SIZE).fill(-1);

  /**
   * Ground height in whole levels, 0..MAX_TERRAIN_HEIGHT.
   *
   * Levels rather than metres: what the simulation ever asks is the *step*
   * between two neighbouring tiles -- what a car climbs, what a track cannot,
   * and whether two structures sharing a tile are at the same place or one is
   * passing over the other.
   */
  readonly height = new Uint8Array(MAP_SIZE * MAP_SIZE);
  /** How far the road on this tile is carried above its ground. 0 = on it. */
  readonly roadRaise = new Uint8Array(MAP_SIZE * MAP_SIZE);
  /** The same for track. A raised track over a road is not a level crossing. */
  readonly railRaise = new Uint8Array(MAP_SIZE * MAP_SIZE);

  /**
   * How far a tile stands above the ground around it, for the view it has.
   *
   * Derived from `height` and never edited, so it is recomputed after the map
   * is generated or loaded rather than saved. It is a field the land value
   * model reads every hour, and blurring the height map on demand would be
   * the most expensive thing in that pass by a long way.
   */
  readonly prominence = new Int8Array(MAP_SIZE * MAP_SIZE);
  /** Precomputed hill shading, 0..255 around 128, so the renderer can index it. */
  readonly shade = new Uint8Array(MAP_SIZE * MAP_SIZE).fill(128);

  isRoad(i: TileIndex): boolean {
    return i >= 0 && this.road[i] === 1;
  }

  isRail(i: TileIndex): boolean {
    return i >= 0 && this.rail[i] === 1;
  }

  /**
   * A tile carrying both a road and a track **at the same height**.
   *
   * The height test is the whole of grade separation: a road carried one level
   * over the track shares the tile and nothing else, so no barrier ever comes
   * down on it. Everything downstream -- the barrier, the renderer's markings,
   * the warnings -- asks this one question, so a flyover cannot be a crossing
   * in one place and not in another.
   */
  isCrossing(i: TileIndex): boolean {
    if (i < 0 || this.road[i] !== 1 || this.rail[i] !== 1) return false;
    return Math.abs(this.roadRaise[i] - this.railRaise[i]) < CLEARANCE;
  }

  /** Height of the road surface on this tile: the ground plus its viaduct. */
  roadHeight(i: TileIndex): number {
    return i < 0 ? 0 : this.height[i] + this.roadRaise[i];
  }

  railHeight(i: TileIndex): number {
    return i < 0 ? 0 : this.height[i] + this.railRaise[i];
  }

  /**
   * The height somebody moving through this tile is at: the road surface where
   * there is one, the ground otherwise.
   *
   * A trip is [door, ...roads, door], so it steps between building tiles and
   * road tiles, and both ends have to answer the same question in the same
   * units or the first and last step of every journey would read as a cliff.
   */
  travelHeight(i: TileIndex): number {
    if (i < 0) return 0;
    return this.road[i] === 1 ? this.roadHeight(i) : this.height[i];
  }

  /** True where a structure stands above its own ground rather than on it. */
  isRaisedRoad(i: TileIndex): boolean {
    return i >= 0 && this.road[i] === 1 && this.roadRaise[i] > 0;
  }

  isRaisedRail(i: TileIndex): boolean {
    return i >= 0 && this.rail[i] === 1 && this.railRaise[i] > 0;
  }

  /**
   * The unevenness of the ground a building would stand on: the largest
   * height difference between this tile and its neighbours.
   */
  relief(i: TileIndex): number {
    if (i < 0) return 0;
    const here = this.height[i];
    let worst = 0;
    for (const n of neighbors(i)) worst = Math.max(worst, Math.abs(this.height[n] - here));
    return worst;
  }

  /**
   * Recompute everything derived from the height map.
   *
   * Called once after the terrain is generated and once after a save is
   * loaded -- the two moments the heights can change -- so nothing downstream
   * has to wonder whether the relief it is reading is current.
   */
  refreshRelief(): void {
    const size = MAP_SIZE;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = idx(x, y);

        // Prominence: how far this tile stands above its surroundings. A
        // 5-tile mean is deliberately coarse -- what a view is worth is about
        // the hill, not about the tile next door.
        let sum = 0;
        let n = 0;
        for (let dy = -3; dy <= 3; dy++) {
          for (let dx = -3; dx <= 3; dx++) {
            const near = this.at(x + dx, y + dy);
            if (near < 0) continue;
            sum += this.height[near];
            n++;
          }
        }
        this.prominence[i] = Math.round(this.height[i] - sum / Math.max(1, n));

        // Hill shading with the light from the north-west, which is what makes
        // a height map read as ground rather than as a colour ramp.
        const west = this.at(x - 1, y);
        const east = this.at(x + 1, y);
        const north = this.at(x, y - 1);
        const south = this.at(x, y + 1);
        const dzx = (west < 0 ? this.height[i] : this.height[west])
          - (east < 0 ? this.height[i] : this.height[east]);
        const dzy = (north < 0 ? this.height[i] : this.height[north])
          - (south < 0 ? this.height[i] : this.height[south]);
        const lit = 128 + (dzx + dzy) * 16 + (this.height[i] - MAX_TERRAIN_HEIGHT / 2) * 4;
        this.shade[i] = Math.max(60, Math.min(200, Math.round(lit)));
      }
    }
  }

  isBuildable(i: TileIndex): boolean {
    return (
      i >= 0 &&
      this.terrain[i] === Terrain.Grass &&
      this.road[i] === 0 &&
      this.rail[i] === 0 &&
      this.building[i] === -1
    );
  }

  getZone(i: TileIndex): Zone {
    return this.zone[i] as Zone;
  }

  getResource(i: TileIndex): Resource {
    return i >= 0 ? (this.resource[i] as Resource) : Resource.None;
  }

  isWater(i: TileIndex): boolean {
    return i >= 0 && this.terrain[i] === Terrain.Water;
  }

  at(x: number, y: number): TileIndex {
    return inBounds(x, y) ? idx(x, y) : -1;
  }
}
