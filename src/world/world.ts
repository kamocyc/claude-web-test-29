import { CAR_PROFILE, TRAIN_PROFILE } from '../sim/carFollowing';
import { gradeStepCost } from '../sim/gradient';
import type { StepCost } from '../sim/pathfinding';
import {
  MAP_SIZE,
  MAX_BUILD_RELIEF,
  MAX_RAISE,
  MAX_RAIL_STEP,
  MAX_TERRAIN_HEIGHT,
} from '../config';
import { idx, neighbors } from '../core/grid';
import { Rng } from '../core/rng';
import {
  BuildingType,
  CitizenState,
  Resource,
  Terrain,
  Zone,
  type BuildingId,
  type LineId,
  type TileIndex,
} from '../core/types';
import { tileCenterX, tileCenterY, type Citizen } from '../sim/citizen';
import {
  capacityFor,
  isEmergencyStation,
  isHome,
  isTransitStop,
  isWorkplace,
  specFor,
  type Building,
} from './buildings';
import { groundSupports } from './zoneRules';
import { TileMap } from './tileMap';
import { TileNetwork } from './tileNetwork';
import type { Lorry } from '../sim/lorry';
import { BUS_ID_BASE, createBus, type Bus } from '../sim/bus';
import { UnitState, type EmergencyUnit } from '../sim/emergency';
import { layoutRoadRoute } from './lineBuilder';
import {
  LINE_COLORS,
  LineMode,
  specForMode,
  type TransitLine,
  type Train,
} from './transit';

/** How wide the river's valley is, in tiles either side of the water. */
const VALLEY_WIDTH = 14;

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
  /**
   * The buses. Like the lorries and unlike the citizens, this array is never
   * compacted: a bus whose route was withdrawn keeps its slot and the next
   * line reuses it, so a bus id stays meaningful for as long as anybody is
   * holding one.
   */
  readonly buses: Bus[] = [];
  /** Fire engines and patrol cars, kept the same way for the same reason. */
  readonly units: EmergencyUnit[] = [];
  readonly rng: Rng;

  /** Bumped whenever buildings or lines appear or vanish, so UI can refresh. */
  revision = 0;

  /**
   * Handed to each new citizen as their permanent identity. It only ever goes
   * up, so two people who lived here at different times never share one, even
   * though the id array is compacted when somebody leaves.
   */
  nextCitizenSeed = 0;

  /**
   * What one step of road costs a driver, with the hill in it.
   *
   * Held as a field rather than passed around so that every road search in
   * the game -- commuters, lorries, buses, fire engines -- prices a gradient
   * the same way. A route that avoids the hill is not a special case anybody
   * has to remember to ask for.
   */
  readonly roadStep: StepCost = (from, to) => gradeStepCost(
    this.map.roadHeight(to) - this.map.roadHeight(from),
    CAR_PROFILE.gradeSensitivity,
  );

  /** The same for track, which loses more of its speed to a climb than a car. */
  readonly railStep: StepCost = (from, to) => gradeStepCost(
    this.map.railHeight(to) - this.map.railHeight(from),
    TRAIN_PROFILE.gradeSensitivity,
  );

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
    this.generateHeight(river);
    this.generateResources(river);
    this.map.refreshRelief();
  }

  /**
   * The lie of the land: rolling ground from a few octaves of value noise,
   * cut through by the valley the river runs in.
   *
   * Two properties are being aimed for rather than realism. Most of the map
   * has to be *gently* sloped, because a city that cannot be built anywhere
   * is not a city builder; and a few places have to be genuinely steep, so
   * that a railway alignment is a decision and a viaduct is worth its price.
   * Quantising a smooth field to whole levels gives both for free: contour
   * lines spread out over the flats and bunch into a step of two or three
   * where the field is steep.
   */
  private generateHeight(river: number[]): void {
    const field = new Float32Array(MAP_SIZE * MAP_SIZE);
    for (const [cells, amplitude] of [[4, 1], [8, 0.5], [16, 0.22]] as const) {
      this.addNoise(field, cells, amplitude);
    }

    let low = Infinity;
    let high = -Infinity;
    for (const v of field) {
      low = Math.min(low, v);
      high = Math.max(high, v);
    }
    const span = Math.max(1e-6, high - low);

    for (let y = 0; y < MAP_SIZE; y++) {
      for (let x = 0; x < MAP_SIZE; x++) {
        const tile = idx(x, y);
        let v = (field[tile] - low) / span;

        // The river is at the bottom of a valley, and the valley floor is
        // wide enough to build a town on. Without this the water would run
        // along a hillside, which reads as broken however pretty the noise is.
        const toRiver = Math.abs(x - river[y]);
        if (toRiver < VALLEY_WIDTH) {
          const t = toRiver / VALLEY_WIDTH;
          v *= t * t * (3 - 2 * t);
        }
        this.map.height[tile] = this.map.isWater(tile)
          ? 0
          : Math.max(0, Math.min(MAX_TERRAIN_HEIGHT, Math.round(v * MAX_TERRAIN_HEIGHT)));
      }
    }
  }

  /** One octave of value noise: a coarse lattice, smoothly interpolated. */
  private addNoise(field: Float32Array, cells: number, amplitude: number): void {
    const lattice = new Float32Array((cells + 1) * (cells + 1));
    for (let i = 0; i < lattice.length; i++) lattice[i] = this.rng.next();

    const step = MAP_SIZE / cells;
    const fade = (t: number): number => t * t * (3 - 2 * t);

    for (let y = 0; y < MAP_SIZE; y++) {
      const gy = Math.min(cells - 1, Math.floor(y / step));
      const fy = fade(y / step - gy);
      for (let x = 0; x < MAP_SIZE; x++) {
        const gx = Math.min(cells - 1, Math.floor(x / step));
        const fx = fade(x / step - gx);

        const a = lattice[gy * (cells + 1) + gx];
        const b = lattice[gy * (cells + 1) + gx + 1];
        const c = lattice[(gy + 1) * (cells + 1) + gx];
        const d = lattice[(gy + 1) * (cells + 1) + gx + 1];
        const top = a + (b - a) * fx;
        const bottom = c + (d - c) * fx;
        field[idx(x, y)] += (top + (bottom - top) * fy) * amplitude;
      }
    }
  }

  /**
   * Level a rectangle of ground.
   *
   * Cities are built on levelled sites, and the opening scenario needs one:
   * a town laid out on whatever the noise happened to produce would have its
   * streets refused halfway along. It is deliberately *not* offered to the
   * player as a tool -- terraforming would make every height in the map a
   * suggestion, and the point of the heights is that they are a constraint.
   */
  levelGround(x0: number, y0: number, x1: number, y1: number, height: number): void {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const tile = this.map.at(x, y);
        if (tile < 0 || this.map.isWater(tile)) continue;
        this.map.height[tile] = height;
      }
    }
    this.map.refreshRelief();
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
    if (!this.railGradeAllows(tile, 0)) return false;

    this.map.rail[tile] = 1;
    this.map.railRaise[tile] = 0;
    this.map.zone[tile] = Zone.None;
    this.rails.update(tile);
    return true;
  }

  /**
   * Whether track may sit at this height here, given the track around it.
   *
   * The one hard gradient rule in the game. A road can climb anything badly;
   * a railway cannot climb at all beyond a level per tile, so a line either
   * follows the contours, goes the long way round, or is carried over the
   * ground -- which is the decision this rule exists to force.
   */
  railGradeAllows(tile: TileIndex, raise: number): boolean {
    const here = this.map.height[tile] + raise;
    for (const n of neighbors(tile)) {
      if (!this.map.isRail(n)) continue;
      if (Math.abs(this.map.railHeight(n) - here) > MAX_RAIL_STEP) return false;
    }
    return true;
  }

  /**
   * Carry a road one level higher here, laying it first if there is none.
   *
   * This is the whole elevated-structure interaction: one tool, applied
   * repeatedly. A single level clears the track underneath, so a flyover is
   * one pass; a second level clears a viaduct that is already there. Over
   * water it is a bridge, and it is the only way this city has ever had of
   * getting to the far bank.
   */
  raiseRoad(tile: TileIndex): boolean {
    if (tile < 0) return false;
    if (this.map.building[tile] !== -1) return false;
    if (this.map.roadRaise[tile] >= MAX_RAISE) return false;

    if (this.map.road[tile] === 1) {
      this.map.roadRaise[tile]++;
      // The network is unchanged, but what it costs to drive over this tile is
      // not: bumping the version drops the path cache, which prices gradients.
      this.roads.update(tile);
      return true;
    }
    // A new structure starts one level up: on the ground it would be an
    // ordinary road, and the ordinary road tool is cheaper.
    this.map.road[tile] = 1;
    this.map.roadRaise[tile] = 1;
    this.map.zone[tile] = Zone.None;
    this.roads.update(tile);
    return true;
  }

  /** The same for track, which additionally has a gradient to answer to. */
  raiseRail(tile: TileIndex): boolean {
    if (tile < 0) return false;
    if (this.map.building[tile] !== -1) return false;
    if (this.map.railRaise[tile] >= MAX_RAISE) return false;

    const raise = this.map.railRaise[tile] + 1;
    if (!this.railGradeAllows(tile, raise)) return false;

    if (this.map.rail[tile] === 1) {
      this.map.railRaise[tile] = raise;
      this.rails.update(tile);
      return true;
    }
    this.map.rail[tile] = 1;
    this.map.railRaise[tile] = 1;
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
    // Buildings need a level plot. On gentle ground this never bites; on an
    // escarpment it is what keeps the hillside green.
    if (this.map.relief(tile) > MAX_BUILD_RELIEF) return false;
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

  /**
   * A bus stop: a shelter beside the road the buses call at.
   *
   * It needs nothing but a road to stand next to -- no track, no platform,
   * no clear route to anywhere. That is the whole point of a bus: the network
   * it runs on is the one the city already has.
   */
  placeBusStop(tile: TileIndex): Building | null {
    if (tile < 0 || !this.map.isBuildable(tile)) return null;
    if (this.adjacentRoad(tile) < 0) return null;
    return this.addBuilding(tile, BuildingType.BusStop);
  }

  /**
   * A civic service: a school, a fire station or a police station.
   *
   * Placed like a power plant rather than zoned, because these are the city's
   * own buildings: demand never asks for one and never abandons one, and the
   * city pays their upkeep every day whether or not anybody notices them.
   */
  placeService(tile: TileIndex, type: BuildingType): Building | null {
    if (tile < 0 || !this.map.isBuildable(tile)) return null;
    if (this.adjacentRoad(tile) < 0) return null;
    return this.addBuilding(tile, type);
  }

  /** Take a track tile back up. The inverse of `placeRail`. */
  removeRail(tile: TileIndex): boolean {
    if (tile < 0 || this.map.rail[tile] !== 1) return false;
    this.map.rail[tile] = 0;
    this.map.railRaise[tile] = 0;
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
      this.map.roadRaise[tile] = 0;
      this.roads.update(tile);
      this.repairRoadLines(tile);
      changed = true;
    }
    if (this.map.rail[tile] === 1) {
      this.map.rail[tile] = 0;
      this.map.railRaise[tile] = 0;
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

  /**
   * The road a building's occupants come and go by.
   *
   * Ground level is preferred over a viaduct: a front door opening onto the
   * middle of a flyover is not a front door, and the tile beside it usually
   * has an ordinary street on it.
   */
  adjacentRoad(tile: TileIndex): TileIndex {
    let raised = -1;
    for (const n of neighbors(tile)) {
      if (!this.map.isRoad(n)) continue;
      if (this.map.roadRaise[n] === 0) return n;
      if (raised < 0) raised = n;
    }
    return raised;
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
    const wasHome = isHome(b.type);
    for (const cid of b.occupants) {
      const c = this.citizens[cid];
      if (!c) continue;
      c.path = null;
      // Losing your workplace makes you jobless, not stuck travelling to a
      // building that is no longer there.
      if (c.work === id) c.work = -1;
      if (wasHome) this.rehouse(c);
    }
    b.occupants = [];
    b.capacity = 0;
    b.alive = false;
    if (isTransitStop(b.type)) this.removeLinesServing(id);
    if (isEmergencyStation(b.type)) this.retireUnitsOf(id);
    this.revision++;
  }

  /**
   * Somebody whose home has just gone -- bulldozed, or burnt down.
   *
   * They take the first empty dwelling in the city, and leave altogether if
   * there is not one. Doing nothing was not an option: a citizen still
   * attached to a building that no longer exists stands in the street for
   * good, because every trip they plan starts from an address that cannot be
   * routed from, and they retry it forever.
   */
  private rehouse(c: Citizen): void {
    for (const home of this.buildings) {
      if (!home.alive || !isHome(home.type)) continue;
      if (home.occupants.length >= home.capacity) continue;
      home.occupants.push(c.id);
      c.home = home.id;
      c.state = CitizenState.AtHome;
      c.x = tileCenterX(home.tile);
      c.y = tileCenterY(home.tile);
      c.prevX = c.x;
      c.prevY = c.y;
      return;
    }
    // Nowhere to go: they leave the city at the next migration pass, and stay
    // indoors rather than stranded in the meantime.
    c.left = true;
    c.state = CitizenState.AtHome;
  }

  /**
   * The station has gone, so its engines have nowhere to return to. They are
   * retired where they stand rather than driven home to a demolished yard,
   * and their slots go to the next station the player builds.
   */
  private retireUnitsOf(station: BuildingId): void {
    for (const unit of this.units) {
      if (unit.home !== station) continue;
      unit.home = -1;
      unit.incident = -1;
      unit.state = UnitState.Retired;
      unit.path = null;
      unit.v = 0;
    }
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

  addLine(
    stations: BuildingId[],
    route: TileIndex[],
    stopAt: number[],
    mode = LineMode.Rail,
  ): TransitLine {
    const spec = specForMode(mode);
    const railways = this.lines.filter((l) => l.mode === LineMode.Rail).length;
    const routes = this.lines.length - railways;
    const line: TransitLine = {
      id: this.lines.length,
      name: mode === LineMode.Rail ? `${railways + 1}号線` : `バス${routes + 1}系統`,
      color: LINE_COLORS[this.lines.length % LINE_COLORS.length],
      mode,
      stations,
      route,
      stopAt,
      stopStation: stopAt.map((_, i) => stationForStop(stations, i)),
      vehicles: [],
      ridership: 0,
    };
    this.lines.push(line);

    if (mode === LineMode.Rail) this.addTrains(line, spec.vehicles);
    else this.addBuses(line, spec.vehicles);

    this.revision++;
    return line;
  }

  /**
   * Space the trains evenly around the round trip so the headway is even from
   * the first tick, rather than letting them bunch at the terminus.
   */
  private addTrains(line: TransitLine, count: number): void {
    const lap = line.route.length - 1;
    for (let i = 0; i < count; i++) {
      const train: Train = {
        id: this.trains.length,
        line: line.id,
        s: (lap * i) / count,
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
      line.vehicles.push(train.id);
    }
  }

  /**
   * Buses start spread over the stops rather than over the route.
   *
   * A bus plans its way from stop to stop over the live road network, so it
   * has no position along a stored route to be spaced along -- and starting
   * them all at the terminus would send three buses round the city nose to
   * tail, which is exactly the bunching the spacing exists to avoid.
   */
  private addBuses(line: TransitLine, count: number): void {
    const stops = line.stopAt.length;
    for (let i = 0; i < count; i++) {
      const at = Math.round((stops * i) / count) % stops;
      const stop = this.buildings[line.stopStation[at]];
      const slot = this.buses.findIndex((b) => b.line < 0);
      const bus = createBus(
        slot >= 0 ? slot : this.buses.length,
        line.id,
        at,
        stop ? stop.tile : line.route[0],
      );
      if (slot >= 0) this.buses[slot] = bus;
      else this.buses.push(bus);
      line.vehicles.push(bus.id);
    }
  }

  /**
   * A road a bus route runs over has just gone. Re-route the line around the
   * gap if the stops are still joined up, and withdraw it if they are not.
   *
   * Rail lines are simply withdrawn when their track is cut (below), and the
   * asymmetry is deliberate: track exists to carry the line, so cutting it is
   * a decision about the line. A road is the city's, and it gets moved,
   * widened and re-laid for reasons that have nothing to do with the buses --
   * killing the route every time would make bus lines unusable next to a
   * player who is still building.
   */
  private repairRoadLines(tile: TileIndex): void {
    for (const line of this.lines) {
      if (line.mode !== LineMode.Road || !this.lineIsAlive(line)) continue;
      if (!line.route.includes(tile)) continue;

      const layout = layoutRoadRoute(this, line.stations);
      if (!layout) {
        this.removeLine(line.id);
        continue;
      }
      line.route = layout.route;
      line.stopAt = layout.stopAt;
      line.stopStation = layout.stopAt.map((_, i) => stationForStop(line.stations, i));
      // Every bus on the line re-plans from where it stands; the stop it was
      // driving to is still the stop it is driving to.
      for (const id of line.vehicles) {
        const bus = this.buses[id - BUS_ID_BASE];
        if (bus) bus.path = null;
      }
      this.revision++;
    }
  }

  private removeLinesServing(station: BuildingId): void {
    for (const line of this.lines) {
      if (line.stations.includes(station)) this.removeLine(line.id);
    }
  }

  private invalidateLinesUsing(tile: TileIndex): void {
    if (tile < 0) return;
    for (const line of this.lines) {
      if (line.route.includes(tile)) this.removeLine(line.id);
    }
  }

  /** Lines are tombstoned the same way buildings are: emptied, not spliced. */
  private removeLine(id: LineId): void {
    const line = this.lines[id];
    if (!line || line.route.length === 0) return;

    for (const vid of line.vehicles) {
      const vehicle = line.mode === LineMode.Rail
        ? this.trains[vid]
        : this.buses[vid - BUS_ID_BASE];
      if (!vehicle) continue;
      for (const cid of vehicle.passengers) {
        const c = this.citizens[cid];
        // Put riders back on the pavement; they will re-plan from there.
        if (c) c.path = null;
      }
      vehicle.passengers = [];
      // A bus with no line is a free slot; a train belongs to its line and
      // simply stops existing with it.
      if (line.mode === LineMode.Road) {
        const bus = vehicle as Bus;
        bus.line = -1;
        bus.path = null;
        bus.v = 0;
      }
    }
    line.vehicles = [];
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
