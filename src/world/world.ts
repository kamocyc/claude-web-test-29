import { MAP_SIZE } from '../config';
import { idx, neighbors } from '../core/grid';
import { Rng } from '../core/rng';
import {
  BuildingType,
  Terrain,
  Zone,
  type BuildingId,
  type TileIndex,
} from '../core/types';
import type { Citizen } from '../sim/citizen';
import { capacityFor, type Building } from './buildings';
import { RoadNetwork } from './roadNetwork';
import { TileMap } from './tileMap';

export class World {
  readonly map = new TileMap();
  readonly roads: RoadNetwork;
  readonly buildings: Building[] = [];
  readonly citizens: Citizen[] = [];
  readonly rng: Rng;

  /** Bumped whenever buildings appear or vanish, so UI lists can refresh. */
  revision = 0;

  constructor(seed = 1) {
    this.rng = new Rng(seed);
    this.roads = new RoadNetwork(this.map);
    this.generateTerrain();
  }

  private generateTerrain(): void {
    // A single meandering river, purely so the map is not a blank sheet and
    // road layout has something to route around.
    const t = this.map.terrain;
    t.fill(Terrain.Grass);
    let x = MAP_SIZE * 0.3;
    for (let y = 0; y < MAP_SIZE; y++) {
      x += this.rng.range(-0.9, 0.9);
      x = Math.min(MAP_SIZE - 6, Math.max(5, x));
      const width = 2 + Math.floor(this.rng.next() * 2);
      for (let w = -width; w <= width; w++) {
        const px = Math.round(x + w);
        if (px >= 0 && px < MAP_SIZE) t[idx(px, y)] = Terrain.Water;
      }
    }
  }

  // --- Player actions ------------------------------------------------------

  placeRoad(tile: TileIndex): boolean {
    if (tile < 0) return false;
    if (this.map.terrain[tile] === Terrain.Water) return false;
    if (this.map.road[tile] === 1) return false;
    if (this.map.building[tile] !== -1) return false;

    this.map.road[tile] = 1;
    this.map.zone[tile] = Zone.None;
    this.roads.update(tile);
    return true;
  }

  /** Zoning only takes on tiles touching a road -- buildings need access. */
  paintZone(tile: TileIndex, zone: Zone): boolean {
    if (tile < 0) return false;
    if (!this.map.isBuildable(tile)) return false;
    if (this.adjacentRoad(tile) < 0) return false;
    if (this.map.zone[tile] === zone) return false;

    this.map.zone[tile] = zone;
    return true;
  }

  bulldoze(tile: TileIndex): boolean {
    if (tile < 0) return false;
    let changed = false;

    const bid = this.map.building[tile];
    if (bid !== -1) {
      this.removeBuilding(bid);
      changed = true;
    }
    if (this.map.road[tile] === 1) {
      this.map.road[tile] = 0;
      this.roads.update(tile);
      changed = true;
    }
    if (this.map.zone[tile] !== Zone.None) {
      this.map.zone[tile] = Zone.None;
      changed = true;
    }
    return changed;
  }

  adjacentRoad(tile: TileIndex): TileIndex {
    for (const n of neighbors(tile)) {
      if (this.map.isRoad(n)) return n;
    }
    return -1;
  }

  // --- Buildings -----------------------------------------------------------

  addBuilding(tile: TileIndex, type: BuildingType): Building | null {
    const access = this.adjacentRoad(tile);
    if (access < 0 || !this.map.isBuildable(tile)) return null;

    const b: Building = {
      id: this.buildings.length,
      type,
      tile,
      accessRoad: access,
      capacity: capacityFor(type),
      occupants: [],
    };
    this.buildings.push(b);
    this.map.building[tile] = b.id;
    this.revision++;
    return b;
  }

  /**
   * Buildings are tombstoned rather than spliced out: ids are array indices
   * used all over the sim, so compacting the array would invalidate them.
   */
  private removeBuilding(id: BuildingId): void {
    const b = this.buildings[id];
    if (!b || b.capacity === 0) return;

    this.map.building[b.tile] = -1;
    for (const cid of b.occupants) {
      const c = this.citizens[cid];
      if (c) c.path = null;
    }
    b.occupants = [];
    b.capacity = 0;
    this.revision++;
  }

  isAlive(b: Building): boolean {
    return b.capacity > 0;
  }

  /** A building whose access road was bulldozed needs a fresh one. */
  refreshAccess(b: Building): void {
    if (!this.map.isRoad(b.accessRoad)) {
      b.accessRoad = this.adjacentRoad(b.tile);
    }
  }

  get population(): number {
    return this.citizens.length;
  }

  get jobCount(): number {
    let n = 0;
    for (const b of this.buildings) {
      if (b.type === BuildingType.Commerce) n += b.capacity;
    }
    return n;
  }

  get employedCount(): number {
    let n = 0;
    for (const b of this.buildings) {
      if (b.type === BuildingType.Commerce) n += b.occupants.length;
    }
    return n;
  }
}
