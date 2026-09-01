import { MAP_SIZE, TRAINS_PER_LINE } from '../config';
import { idx, neighbors } from '../core/grid';
import { Rng } from '../core/rng';
import {
  BuildingType,
  Terrain,
  Zone,
  type BuildingId,
  type LineId,
  type TileIndex,
} from '../core/types';
import type { Citizen } from '../sim/citizen';
import { capacityFor, type Building } from './buildings';
import { TileMap } from './tileMap';
import { TileNetwork } from './tileNetwork';
import { LINE_COLORS, type TransitLine, type Train } from './transit';

export class World {
  readonly map = new TileMap();
  readonly roads: TileNetwork;
  readonly rails: TileNetwork;
  readonly buildings: Building[] = [];
  readonly citizens: Citizen[] = [];
  readonly lines: TransitLine[] = [];
  readonly trains: Train[] = [];
  readonly rng: Rng;

  /** Bumped whenever buildings or lines appear or vanish, so UI can refresh. */
  revision = 0;

  constructor(seed = 1) {
    this.rng = new Rng(seed);
    this.roads = new TileNetwork((t) => this.map.isRoad(t));
    this.rails = new TileNetwork((t) => this.map.isRail(t));
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
    // Roads and rails may share a tile: that is a level crossing.

    this.map.road[tile] = 1;
    this.map.zone[tile] = Zone.None;
    this.roads.update(tile);
    return true;
  }

  placeRail(tile: TileIndex): boolean {
    if (tile < 0) return false;
    if (this.map.terrain[tile] === Terrain.Water) return false;
    if (this.map.rail[tile] === 1) return false;
    if (this.map.building[tile] !== -1) return false;

    this.map.rail[tile] = 1;
    this.map.zone[tile] = Zone.None;
    this.rails.update(tile);
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

  /**
   * A station needs track to serve it and a pavement for passengers to reach
   * it, so it can only go on a tile that touches both.
   */
  placeStation(tile: TileIndex): Building | null {
    if (tile < 0 || !this.map.isBuildable(tile)) return null;
    const road = this.adjacentRoad(tile);
    const platform = this.adjacentRail(tile);
    if (road < 0 || platform < 0) return null;

    const b = this.addBuilding(tile, BuildingType.Station);
    if (b) b.platform = platform;
    return b;
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
    if (this.map.rail[tile] === 1) {
      this.map.rail[tile] = 0;
      this.rails.update(tile);
      this.invalidateLinesUsing(tile);
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

  adjacentRail(tile: TileIndex): TileIndex {
    for (const n of neighbors(tile)) {
      if (this.map.isRail(n)) return n;
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
      platform: -1,
      capacity: capacityFor(type),
      occupants: [],
      alive: true,
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
    if (!b || !b.alive) return;

    this.map.building[b.tile] = -1;
    for (const cid of b.occupants) {
      const c = this.citizens[cid];
      if (c) c.path = null;
    }
    b.occupants = [];
    b.capacity = 0;
    b.alive = false;
    if (b.type === BuildingType.Station) this.removeLinesServing(id);
    this.revision++;
  }

  isAlive(b: Building | undefined): boolean {
    return b !== undefined && b.alive;
  }

  /** A building whose access road was bulldozed needs a fresh one. */
  refreshAccess(b: Building): void {
    if (!this.map.isRoad(b.accessRoad)) {
      b.accessRoad = this.adjacentRoad(b.tile);
    }
  }

  // --- Transit -------------------------------------------------------------

  addLine(stations: BuildingId[], route: TileIndex[], stopAt: number[]): TransitLine {
    const line: TransitLine = {
      id: this.lines.length,
      name: `${this.lines.length + 1}号線`,
      color: LINE_COLORS[this.lines.length % LINE_COLORS.length],
      stations,
      route,
      stopAt,
      stopStation: stopAt.map((_, i) => stationForStop(stations, i)),
      trains: [],
      ridership: 0,
    };
    this.lines.push(line);

    // Space the trains evenly around the round trip so the headway is even
    // from the first tick, rather than letting them bunch at the terminus.
    const lap = route.length - 1;
    for (let i = 0; i < TRAINS_PER_LINE; i++) {
      const train: Train = {
        id: this.trains.length,
        line: line.id,
        s: (lap * i) / TRAINS_PER_LINE,
        v: 0,
        nextStop: 0,
        dwellUntil: 0,
        passengers: [],
        x: 0,
        y: 0,
        prevX: 0,
        prevY: 0,
      };
      this.trains.push(train);
      line.trains.push(train.id);
    }
    this.revision++;
    return line;
  }

  private removeLinesServing(station: BuildingId): void {
    for (const line of this.lines) {
      if (line.stations.includes(station)) this.removeLine(line.id);
    }
  }

  private invalidateLinesUsing(tile: TileIndex): void {
    for (const line of this.lines) {
      if (line.route.includes(tile)) this.removeLine(line.id);
    }
  }

  /** Lines are tombstoned the same way buildings are: emptied, not spliced. */
  private removeLine(id: LineId): void {
    const line = this.lines[id];
    if (!line || line.route.length === 0) return;

    for (const tid of line.trains) {
      const train = this.trains[tid];
      if (!train) continue;
      for (const cid of train.passengers) {
        const c = this.citizens[cid];
        // Put riders back on the pavement; they will re-plan from there.
        if (c) c.path = null;
      }
      train.passengers = [];
    }
    line.trains = [];
    line.route = [];
    line.stopAt = [];
    line.stopStation = [];
    line.stations = [];
    this.revision++;
  }

  lineIsAlive(line: TransitLine): boolean {
    return line.route.length > 0;
  }

  get activeLines(): TransitLine[] {
    return this.lines.filter((l) => this.lineIsAlive(l));
  }

  get stations(): Building[] {
    return this.buildings.filter((b) => b.alive && b.type === BuildingType.Station);
  }

  // --- Stats ---------------------------------------------------------------

  get population(): number {
    return this.citizens.length;
  }

  get jobCount(): number {
    let n = 0;
    for (const b of this.buildings) {
      if (b.alive && b.type === BuildingType.Commerce) n += b.capacity;
    }
    return n;
  }

  get employedCount(): number {
    let n = 0;
    for (const b of this.buildings) {
      if (b.alive && b.type === BuildingType.Commerce) n += b.occupants.length;
    }
    return n;
  }
}

/**
 * Map a stop occurrence to its station. The round trip visits stations
 * 0..n-1 and then back down n-2..1, so the second half mirrors the first.
 */
function stationForStop(stations: BuildingId[], stop: number): BuildingId {
  const n = stations.length;
  return stop < n ? stations[stop] : stations[2 * n - 2 - stop];
}
