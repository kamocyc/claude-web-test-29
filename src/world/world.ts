import { MAP_SIZE, TRAINS_PER_LINE } from '../config';
import { idx, neighbors } from '../core/grid';
import { Rng } from '../core/rng';
import {
  BuildingType,
  Resource,
  Terrain,
  Zone,
  type BuildingId,
  type LineId,
  type TileIndex,
} from '../core/types';
import type { Citizen } from '../sim/citizen';
import { capacityFor, isHome, isWorkplace, specFor, type Building } from './buildings';
import { groundSupports } from './zoneRules';
import { TileMap } from './tileMap';
import { TileNetwork } from './tileNetwork';
import type { Lorry } from '../sim/lorry';
import { LINE_COLORS, type TransitLine, type Train } from './transit';

export class World {
  readonly map = new TileMap();
  readonly roads: TileNetwork;
  readonly rails: TileNetwork;
  readonly buildings: Building[] = [];
  readonly citizens: Citizen[] = [];
  readonly lines: TransitLine[] = [];
  readonly trains: Train[] = [];
  /**
   * The freight fleet. Unlike citizens this array is never compacted: a
   * retired lorry keeps its slot and the next delivery reuses it, which is
   * what lets a lorry's id stay stable without any renumbering pass.
   */
  readonly lorries: Lorry[] = [];
  readonly rng: Rng;

  /** Bumped whenever buildings or lines appear or vanish, so UI can refresh. */
  revision = 0;

  /**
   * Handed to each new citizen as their permanent identity. It only ever goes
   * up, so two people who lived here at different times never share one, even
   * though the id array is compacted when somebody leaves.
   */
  nextCitizenSeed = 0;

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
    const river: number[] = [];
    let x = MAP_SIZE * 0.3;
    for (let y = 0; y < MAP_SIZE; y++) {
      x += this.rng.range(-0.9, 0.9);
      x = Math.min(MAP_SIZE - 6, Math.max(5, x));
      river.push(x);
      const width = 2 + Math.floor(this.rng.next() * 2);
      for (let w = -width; w <= width; w++) {
        const px = Math.round(x + w);
        if (px >= 0 && px < MAP_SIZE) t[idx(px, y)] = Terrain.Water;
      }
    }
    this.generateResources(river);
  }

  /**
   * Where the primary industries can go.
   *
   * The three deposits are laid down in a fixed order rather than by one noise
   * function, because each one wants a different relationship to the map: the
   * fertile ground follows the river (that is what makes it fertile), the
   * forest wants to be somewhere the city has to reach out to, and the ore
   * wants to be in a couple of concentrated seams so that mining is a place
   * rather than an option available everywhere.
   */
  private generateResources(river: number[]): void {
    const r = this.map.resource;
    r.fill(Resource.None);

    // Fertile flood plain: a band either side of the river.
    for (let y = 0; y < MAP_SIZE; y++) {
      const cx = river[y];
      for (let dx = -9; dx <= 9; dx++) {
        const px = Math.round(cx + dx);
        if (px < 0 || px >= MAP_SIZE) continue;
        const tile = idx(px, y);
        if (this.map.terrain[tile] === Terrain.Water) continue;
        if (Math.abs(dx) > 4) r[tile] = Resource.Fertile;
      }
    }

    // A handful of woods and seams, as round blobs with ragged edges.
    this.scatter(Resource.Forest, 7, 9, 15);
    this.scatter(Resource.Ore, 3, 5, 8);
  }

  private scatter(kind: Resource, count: number, minRadius: number, maxRadius: number): void {
    for (let n = 0; n < count; n++) {
      const cx = this.rng.int(MAP_SIZE);
      const cy = this.rng.int(MAP_SIZE);
      const radius = this.rng.range(minRadius, maxRadius);
      const x0 = Math.max(0, Math.floor(cx - radius));
      const x1 = Math.min(MAP_SIZE - 1, Math.ceil(cx + radius));
      const y0 = Math.max(0, Math.floor(cy - radius));
      const y1 = Math.min(MAP_SIZE - 1, Math.ceil(cy + radius));

      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const d = Math.hypot(x - cx, y - cy);
          if (d > radius * this.rng.range(0.75, 1)) continue;
          const tile = idx(x, y);
          if (this.map.terrain[tile] === Terrain.Water) continue;
          this.map.resource[tile] = kind;
        }
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

  /**
   * Zoning takes on tiles that touch a road and whose ground supports the
   * zone. Buildings need access, and primary industry needs its resource.
   */
  paintZone(tile: TileIndex, zone: Zone): boolean {
    if (!this.canZone(tile, zone)) return false;
    if (this.map.zone[tile] === zone) return false;

    this.map.zone[tile] = zone;
    return true;
  }

  canZone(tile: TileIndex, zone: Zone): boolean {
    if (tile < 0) return false;
    if (!this.map.isBuildable(tile)) return false;
    if (this.adjacentRoad(tile) < 0) return false;
    return groundSupports(this.map, zone, tile);
  }

  /**
   * A station needs a pavement for passengers to reach it, so it goes on a
   * tile touching a road.
   *
   * Track is *not* required up front. Demanding it made the player draw a
   * railway before they could say where the stations went, which is backwards:
   * where the stations go is the interesting decision, and the alignment
   * between them is a consequence of it. A station placed beside existing
   * track adopts it as its platform; one placed on open ground gets its
   * platform when a line is run through it.
   */
  /**
   * Power plants are placed by the player rather than grown, like stations:
   * they are infrastructure the city pays for, not something demand produces.
   */
  placePowerPlant(tile: TileIndex): Building | null {
    if (tile < 0 || !this.map.isBuildable(tile)) return null;
    if (this.adjacentRoad(tile) < 0) return null;
    return this.addBuilding(tile, BuildingType.PowerPlant);
  }

  placeStation(tile: TileIndex): Building | null {
    if (tile < 0 || !this.map.isBuildable(tile)) return null;
    if (this.adjacentRoad(tile) < 0) return null;

    const b = this.addBuilding(tile, BuildingType.Station);
    if (b) b.platform = this.adjacentRail(tile);
    return b;
  }

  /** Take a track tile back up. The inverse of `placeRail`. */
  removeRail(tile: TileIndex): boolean {
    if (tile < 0 || this.map.rail[tile] !== 1) return false;
    this.map.rail[tile] = 0;
    this.rails.update(tile);
    this.invalidateLinesUsing(tile);
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
      powered: false,
      rawStock: 0,
      goodsStock: 0,
      soldToday: 0,
      starvedHours: 0,
    };
    this.buildings.push(b);
    this.map.building[tile] = b.id;
    this.revision++;
    return b;
  }

  /** Remove a building: the player bulldozing it, or the city abandoning it. */
  demolish(id: BuildingId): void {
    this.removeBuilding(id);
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
      if (!c) continue;
      c.path = null;
      // Losing your workplace makes you jobless, not stuck travelling to a
      // building that is no longer there.
      if (c.work === id) c.work = -1;
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
      if (b.alive && isWorkplace(b.type)) n += b.capacity;
    }
    return n;
  }

  get employedCount(): number {
    let n = 0;
    for (const b of this.buildings) {
      if (b.alive && isWorkplace(b.type)) n += b.occupants.length;
    }
    return n;
  }

  /** Total dwellings, whether or not anybody has moved in yet. */
  get housingCapacity(): number {
    let n = 0;
    for (const b of this.buildings) {
      if (b.alive && isHome(b.type)) n += b.capacity;
    }
    return n;
  }

  /** Daily upkeep of everything the city itself pays for. */
  get infrastructureUpkeep(): number {
    let total = 0;
    for (const b of this.buildings) {
      if (b.alive) total += specFor(b.type).upkeep;
    }
    return total;
  }

  countTiles(layer: Uint8Array): number {
    let n = 0;
    for (let i = 0; i < layer.length; i++) n += layer[i];
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
