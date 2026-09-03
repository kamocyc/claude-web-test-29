import {
  BUS_CAPACITY,
  CAR_FREE_SPEED,
  LANE_OFFSET,
  LORRY_CAPACITY,
  MAP_SIZE,
  TRAIN_CAPACITY,
  TRAIN_LENGTH,
  WALK_LANE_OFFSET,
} from '../config';
import { idx } from '../core/grid';
import {
  BuildingType,
  CitizenState,
  isAtRest,
  Terrain,
  TravelMode,
  Zone,
  type TileIndex,
} from '../core/types';
import { SignalAxis } from '../sim/signals';
import { BUILDING_ISSUES, buildingIssue, type BuildingIssue } from '../sim/diagnostics';
import { CargoKind } from '../sim/lorry';
import { IncidentKind, UnitState } from '../sim/emergency';
import { Service } from '../sim/services';
import { LineMode } from '../world/transit';
import { isTransitStop } from '../world/buildings';
import type { RoadAgent } from '../sim/vehicle';
import { Resource } from '../core/types';
import type { Citizen } from '../sim/citizen';
import { tileCenterX, tileCenterY } from '../sim/citizen';
import type { Simulation } from '../sim/simulation';
import { COLORS, speedColor, valueColor } from './palette';
import type { Camera } from './camera';
import type { Train } from '../world/transit';

/** Which field is painted over the map, if any. */
export type Overlay =
  | 'none'
  | 'traffic'
  | 'power'
  | 'noise'
  | 'landValue'
  | 'crime'
  | 'services';

export interface RenderOptions {
  showZones: boolean;
  overlay: Overlay;
  hoverTile: TileIndex;
  selected: Citizen | null;
  /** Stations picked so far in the line tool, highlighted while choosing. */
  pendingStations: readonly number[];
  /** Whether to float warning badges over the buildings that have problems. */
  showIssues: boolean;
  /** A building to ring, because the player asked to be shown it. */
  focusTile: TileIndex;
}

export class Renderer {
  /** Stations seen while drawing tiles, so their badges can go on top. */
  private readonly stationBadges: Array<{ id: number; x: number; y: number }> = [];
  /** Failing buildings seen while drawing tiles, for the same reason. */
  private readonly issueBadges: Array<{ issue: BuildingIssue; x: number; y: number }> = [];
  /** Buildings with something happening to them right now: a fire, a burglary. */
  private readonly alarmBadges: Array<{ kind: IncidentKind; x: number; y: number }> = [];

  constructor(
    private readonly ctx: CanvasRenderingContext2D,
    private readonly camera: Camera,
  ) {}

  draw(sim: Simulation, alpha: number, opts: RenderOptions): void {
    const { ctx, camera } = this;
    const w = camera.viewportWidth;
    const h = camera.viewportHeight;

    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, w, h);

    const view = camera.visibleTiles();
    this.stationBadges.length = 0;
    this.issueBadges.length = 0;
    this.alarmBadges.length = 0;
    this.drawTiles(sim, view, opts);
    this.drawLines(sim);
    this.drawSignals(sim, view);
    this.drawAgents(sim, alpha, opts);
    this.drawLorries(sim, alpha);
    this.drawBuses(sim, alpha);
    this.drawUnits(sim, alpha);
    this.drawTrains(sim, alpha);
    this.drawStationBadges(sim);
    this.drawIssueBadges();
    this.drawAlarmBadges();
    this.drawPendingStations(sim, opts);
    if (opts.focusTile >= 0) this.drawFocus(opts.focusTile);
    if (opts.selected) this.drawSelection(opts.selected, alpha);
    if (opts.hoverTile >= 0) this.drawHover(opts.hoverTile);
  }

  private drawTiles(
    sim: Simulation,
    view: { x0: number; y0: number; x1: number; y1: number },
    opts: RenderOptions,
  ): void {
    const { ctx, camera } = this;
    const { map } = sim.world;
    const z = camera.zoom;
    // Gathered once rather than asked per tile: there are a handful of live
    // incidents and thousands of tiles on screen.
    const alarms = new Map<number, IncidentKind>();
    for (const incident of sim.emergency.active) alarms.set(incident.building, incident.kind);

    for (let y = view.y0; y <= view.y1; y++) {
      for (let x = view.x0; x <= view.x1; x++) {
        const i = idx(x, y);
        const p = camera.worldToScreen(x, y);
        // +1 avoids hairline seams between tiles at fractional zoom levels.
        const size = z + 1;

        if (map.terrain[i] === Terrain.Water) {
          ctx.fillStyle = COLORS.water;
        } else if (map.road[i] === 1) {
          ctx.fillStyle = COLORS.road;
        } else if (map.rail[i] === 1) {
          ctx.fillStyle = COLORS.rail;
        } else {
          ctx.fillStyle = groundColor(map.resource[i] as Resource, x, y);
        }
        ctx.fillRect(p.x, p.y, size, size);
        if (map.road[i] === 0 && map.rail[i] === 0 && map.building[i] === -1) {
          this.drawGroundDetail(map.resource[i] as Resource, p.x, p.y, z, i);
        }
        if (map.rail[i] === 1 && z >= 7) this.drawSleepers(p.x, p.y, z);
        if (map.isCrossing(i)) this.drawCrossing(sim, i, p.x, p.y, z);

        const bid = map.building[i];
        if (bid !== -1) {
          const b = sim.world.buildings[bid];
          if (b && sim.world.isAlive(b)) {
            const fill = b.capacity > 0 ? b.occupants.length / b.capacity : 1;
            this.drawBuilding(p.x, p.y, z, b.type, fill);
            // Stops as well as stations: "3人待ち" over a shelter is the same
            // question as over a platform, and the counter is the same one.
            if (isTransitStop(b.type)) {
              this.stationBadges.push({ id: b.id, x: p.x + z / 2, y: p.y });
            }
            // A fire outranks anything else that might be wrong with a
            // building, and it is drawn whether or not the player has the
            // warning badges switched on: it is an event with a deadline
            // rather than a readout they chose to look at.
            const alarm = alarms.get(bid);
            if (alarm !== undefined) {
              this.alarmBadges.push({ kind: alarm, x: p.x + z / 2, y: p.y });
            } else if (opts.showIssues) {
              const issue = buildingIssue(b);
              if (issue !== null) {
                this.issueBadges.push({ issue, x: p.x + z / 2, y: p.y });
              }
            }
          }
        } else if (opts.showZones && map.zone[i] !== Zone.None) {
          ctx.fillStyle = ZONE_COLORS[map.zone[i] as Zone];
          ctx.fillRect(p.x, p.y, size, size);
        }

        this.drawOverlayTile(sim, opts.overlay, i, p.x, p.y, size);
      }
    }
  }

  private drawBuilding(px: number, py: number, z: number, type: BuildingType, fill: number): void {
    const ctx = this.ctx;
    const inset = Math.max(1, z * 0.12);
    ctx.fillStyle = BUILDING_COLORS[type];
    ctx.globalAlpha = 0.45 + 0.55 * Math.min(1, fill);
    ctx.fillRect(px + inset, py + inset, z - inset * 2, z - inset * 2);
    ctx.globalAlpha = 1;

    // Stations get a marker so they stand out from the blocks around them.
    if (type === BuildingType.Station && z >= 7) {
      ctx.strokeStyle = COLORS.station;
      ctx.lineWidth = Math.max(1, z * 0.1);
      ctx.beginPath();
      ctx.arc(px + z / 2, py + z / 2, z * 0.26, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  /**
   * A few marks on bare ground so forest, ore and paddy land read as different
   * places rather than as differently-tinted grass. Only at close zoom: at a
   * distance the base colour already carries it, and the marks would just be
   * noise on every tile of the map.
   */
  private drawGroundDetail(resource: Resource, px: number, py: number, z: number, tile: number): void {
    if (z < 8 || resource === Resource.None || resource === Resource.Fertile) return;
    const ctx = this.ctx;
    // Deterministic per tile, so the scatter does not crawl as the map pans.
    const jitter = (salt: number): number => ((tile * 2654435761 + salt * 40503) % 1000) / 1000;

    if (resource === Resource.Forest) {
      ctx.fillStyle = COLORS.forestTree;
      for (let n = 0; n < 3; n++) {
        const r = Math.max(1, z * 0.1);
        ctx.beginPath();
        ctx.arc(px + z * (0.2 + jitter(n) * 0.6), py + z * (0.2 + jitter(n + 7) * 0.6), r, 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    }
    ctx.fillStyle = COLORS.oreSpeck;
    for (let n = 0; n < 3; n++) {
      const s = Math.max(1, z * 0.12);
      ctx.fillRect(px + z * (0.2 + jitter(n) * 0.6), py + z * (0.2 + jitter(n + 3) * 0.6), s, s);
    }
  }

  /**
   * The data overlays, all painted the same way: one translucent wash per
   * tile, so the map underneath stays readable and two overlays can never be
   * confused for the map itself.
   */
  private drawOverlayTile(
    sim: Simulation,
    overlay: Overlay,
    tile: TileIndex,
    px: number,
    py: number,
    size: number,
  ): void {
    const ctx = this.ctx;
    switch (overlay) {
      case 'none':
        return;
      case 'traffic': {
        if (!sim.world.map.isRoad(tile)) return;
        const mean = sim.occupancy.meanSpeedRatio(tile);
        if (mean < 0) return;
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = speedColor(mean);
        break;
      }
      case 'power': {
        // Roads carry the cables, so the overlay colours the network itself
        // and marks the buildings hanging off it that are still dark.
        const bid = sim.world.map.building[tile];
        if (bid >= 0) {
          const b = sim.world.buildings[bid];
          if (!b || !b.alive) return;
          ctx.globalAlpha = 0.5;
          ctx.fillStyle = b.powered ? COLORS.powered : COLORS.unpowered;
          break;
        }
        if (!sim.world.map.isRoad(tile)) return;
        ctx.globalAlpha = sim.power.gridAt(tile) >= 0 ? 0.25 : 0;
        ctx.fillStyle = COLORS.powered;
        break;
      }
      case 'noise': {
        const level = sim.noise.at(tile);
        if (level < 1) return;
        ctx.globalAlpha = Math.min(0.55, level / 90);
        ctx.fillStyle = COLORS.noise;
        break;
      }
      case 'landValue': {
        const value = sim.landValue.at(tile);
        ctx.globalAlpha = 0.4;
        ctx.fillStyle = valueColor(value / 100);
        break;
      }
      case 'crime': {
        const level = sim.crime.at(tile);
        if (level < 1) return;
        ctx.globalAlpha = Math.min(0.55, level / 90);
        ctx.fillStyle = COLORS.crime;
        break;
      }
      case 'services': {
        // Civic cover is a property of the roads the services run along, so
        // that is what it paints: green where a school and a fire station can
        // both reach, amber where only one can, and nothing at all off the
        // network -- which is itself the answer for an outpost with no road.
        if (!sim.world.map.isRoad(tile)) return;
        const school = sim.services.covers(Service.School, tile);
        const fire = sim.services.covers(Service.Fire, tile);
        if (!school && !fire) {
          ctx.globalAlpha = 0.28;
          ctx.fillStyle = COLORS.uncovered;
          break;
        }
        ctx.globalAlpha = school && fire ? 0.4 : 0.25;
        ctx.fillStyle = COLORS.covered;
        break;
      }
    }
    ctx.fillRect(px, py, size, size);
    ctx.globalAlpha = 1;
  }

  /**
   * Agents are drawn in their lane and facing the way they are going.
   *
   * Both come from the same place: the route segment the citizen is on gives
   * a heading, the heading gives a rotation for the body, and the same vector
   * turned ninety degrees gives the offset that puts traffic on the left-hand
   * side of the road. Opposing flows already live in separate queues in the
   * occupancy model -- this is what makes that visible, so a jam can be read
   * as one direction backing up rather than an undifferentiated blob.
   */
  private drawAgents(sim: Simulation, alpha: number, opts: RenderOptions): void {
    const { ctx, camera } = this;
    const z = camera.zoom;
    // Below this zoom individual dots are sub-pixel noise, so thin them out.
    const stride = z < 6 ? 3 : 1;
    const walkSize = Math.max(1.5, z * 0.18);
    const detailed = z >= 7;

    for (let i = 0; i < sim.world.citizens.length; i += stride) {
      const c = sim.world.citizens[i];
      if (isAtRest(c.state)) continue;
      // Riders are inside the train, which is drawn separately; their dots
      // would just pile up on top of it.
      if (c.state === CitizenState.Riding) continue;

      const pose = agentPose(c, alpha);
      const p = camera.worldToScreen(pose.x, pose.y);
      if (p.x < -8 || p.y < -8 || p.x > camera.viewportWidth + 8 || p.y > camera.viewportHeight + 8) {
        continue;
      }

      if (c.state === CitizenState.Stranded) {
        ctx.fillStyle = COLORS.stranded;
        ctx.fillRect(p.x - walkSize / 2, p.y - walkSize / 2, walkSize, walkSize);
        continue;
      }

      if (c.mode === TravelMode.Car) {
        const color = speedColor(c.v / CAR_FREE_SPEED);
        if (detailed) this.drawCar(p.x, p.y, pose.angle, z, color);
        else {
          const s = Math.max(2, z * 0.3);
          ctx.fillStyle = color;
          ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
        }
      } else {
        ctx.fillStyle = COLORS.pedestrian;
        ctx.fillRect(p.x - walkSize / 2, p.y - walkSize / 2, walkSize, walkSize);
      }
    }

    if (opts.selected) this.drawPath(sim, opts.selected);
  }

  /**
   * A car body with a distinguishable front: a light windscreen band at the
   * nose and a dark tail. At any zoom where the body is more than a few
   * pixels this reads as a direction of travel without needing an arrow.
   */
  private drawCar(px: number, py: number, angle: number, z: number, color: string): void {
    const ctx = this.ctx;
    const length = Math.max(4, z * 0.46);
    const width = Math.max(2.5, z * 0.28);

    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(angle);

    ctx.fillStyle = color;
    ctx.fillRect(-length / 2, -width / 2, length, width);

    // Nose: the bright end always points the way the car is heading.
    ctx.fillStyle = COLORS.carNose;
    ctx.fillRect(length / 2 - length * 0.22, -width / 2, length * 0.22, width);
    // Tail.
    ctx.fillStyle = COLORS.carTail;
    ctx.fillRect(-length / 2, -width / 2, length * 0.16, width);

    ctx.restore();
  }

  private drawPath(sim: Simulation, c: Citizen): void {
    if (c.path) {
      this.strokeTiles(c.path);
      return;
    }
    // Waiting or aboard: `path` is empty because the train is doing the
    // moving, so show the stretch of line they are riding instead. Without
    // this, selecting a passenger shows no route at all -- exactly when the
    // player most wants to know where they are being taken.
    if (!c.ride) return;
    const line = sim.world.lines[c.ride.line];
    if (!line || !sim.world.lineIsAlive(line)) return;

    const from = line.stopAt[c.ride.boardStop];
    const to = line.stopAt[c.ride.alightStop];
    const slice = to >= from
      ? line.route.slice(from, to + 1)
      : [...line.route.slice(from), ...line.route.slice(0, to + 1)];
    this.strokeTiles(slice);
  }

  private strokeTiles(tiles: readonly TileIndex[]): void {
    const { ctx, camera } = this;
    ctx.strokeStyle = COLORS.path;
    ctx.lineWidth = Math.max(1, camera.zoom * 0.12);
    ctx.beginPath();
    for (let i = 0; i < tiles.length; i++) {
      const p = camera.worldToScreen(tileCenterX(tiles[i]), tileCenterY(tiles[i]));
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }

  private drawSelection(c: Citizen, alpha: number): void {
    const { ctx, camera } = this;
    const pose = agentPose(c, alpha);
    const p = camera.worldToScreen(pose.x, pose.y);
    ctx.strokeStyle = COLORS.selection;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(6, camera.zoom * 0.55), 0, Math.PI * 2);
    ctx.stroke();
  }

  /** A level crossing, filled red while a train is claiming it. */
  private drawCrossing(sim: Simulation, tile: TileIndex, px: number, py: number, z: number): void {
    const ctx = this.ctx;
    const closed = sim.crossings.isClosed(tile);
    ctx.strokeStyle = closed ? COLORS.stranded : COLORS.railTie;
    ctx.lineWidth = Math.max(1, z * 0.14);
    ctx.strokeRect(px + z * 0.15, py + z * 0.15, z * 0.7, z * 0.7);
  }

  /** Sleeper ticks, so track reads as track and not just a brown road. */
  private drawSleepers(px: number, py: number, z: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = COLORS.railTie;
    ctx.lineWidth = Math.max(1, z * 0.08);
    ctx.beginPath();
    ctx.moveTo(px + z * 0.5, py);
    ctx.lineTo(px + z * 0.5, py + z);
    ctx.moveTo(px, py + z * 0.5);
    ctx.lineTo(px + z, py + z * 0.5);
    ctx.stroke();
  }

  /** Each line's route drawn in its own colour, so the network is readable. */
  private drawLines(sim: Simulation): void {
    const { ctx, camera } = this;
    for (const line of sim.world.lines) {
      if (!sim.world.lineIsAlive(line)) continue;
      ctx.strokeStyle = line.color;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = Math.max(1.5, camera.zoom * 0.16);
      // A bus route is dashed: it is a claim about roads that belong to
      // everybody, not a railway that belongs to the line.
      ctx.setLineDash(line.mode === LineMode.Road ? [camera.zoom * 0.5, camera.zoom * 0.4] : []);
      ctx.beginPath();
      for (let i = 0; i < line.route.length; i++) {
        const p = camera.worldToScreen(tileCenterX(line.route[i]), tileCenterY(line.route[i]));
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
    }
  }

  private drawTrains(sim: Simulation, alpha: number): void {
    const { ctx, camera } = this;
    const z = camera.zoom;

    for (const train of sim.world.trains) {
      const line = sim.world.lines[train.line];
      if (!line || !sim.world.lineIsAlive(line)) continue;

      const x = train.prevX + (train.x - train.prevX) * alpha;
      const y = train.prevY + (train.y - train.prevY) * alpha;
      const p = camera.worldToScreen(x, y);
      if (p.x < -30 || p.y < -30 || p.x > camera.viewportWidth + 30 || p.y > camera.viewportHeight + 30) {
        continue;
      }

      const w = Math.max(4, z * TRAIN_LENGTH);
      const h = Math.max(3, z * 0.55);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(trainHeading(train));
      ctx.fillStyle = line.color;
      ctx.fillRect(-w / 2, -h / 2, w, h);
      // A load bar along the roof: a full train is visibly full.
      if (z >= 8) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
        ctx.fillRect(-w / 2, -h / 2, w, h * 0.3);
        ctx.fillStyle = '#ffffff';
        const load = Math.min(1, train.passengers.length / TRAIN_CAPACITY);
        ctx.fillRect(-w / 2, -h / 2, w * load, h * 0.3);
      }
      ctx.restore();

      // The load bar says how full; the number says how many. At this zoom
      // the player is watching one line rather than the whole city, and
      // "38/60" is the thing they are actually asking about.
      if (z >= 9) {
        this.drawBadge(p.x, p.y - Math.max(8, z * 0.6), `${train.passengers.length}人`, z);
      }
    }
  }

  /**
   * Freight, drawn as what it is: a longer body with a cab at the front and
   * the load along the back. An empty lorry on its way home reads as empty,
   * which is the difference between "the city is busy" and "the city is
   * running half its lorries for nothing".
   */
  private drawLorries(sim: Simulation, alpha: number): void {
    const { ctx, camera } = this;
    const z = camera.zoom;
    if (z < 4) return;

    for (const lorry of sim.world.lorries) {
      if (!lorry.path) continue;
      const pose = agentPose(lorry, alpha);
      const p = camera.worldToScreen(pose.x, pose.y);
      if (p.x < -12 || p.y < -12 || p.x > camera.viewportWidth + 12
        || p.y > camera.viewportHeight + 12) {
        continue;
      }

      const length = Math.max(5, z * 0.72);
      const width = Math.max(3, z * 0.32);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(pose.angle);

      // The trailer, tinted by what it is carrying and how full it is.
      ctx.fillStyle = COLORS.lorryBody;
      ctx.fillRect(-length / 2, -width / 2, length, width);
      const load = Math.min(1, lorry.cargo / LORRY_CAPACITY);
      if (load > 0) {
        ctx.fillStyle = lorry.cargoKind === CargoKind.Raw ? COLORS.cargoRaw : COLORS.cargoGoods;
        ctx.fillRect(-length / 2, -width / 2, length * 0.72 * load, width);
      }
      // The cab, so which way it is pointing is never in doubt.
      ctx.fillStyle = COLORS.lorryCab;
      ctx.fillRect(length / 2 - length * 0.28, -width / 2, length * 0.28, width);
      ctx.restore();
    }
  }

  /**
   * Signal heads at each junction: two dots on the north/south approaches and
   * two on the east/west ones, so which movement currently holds the green is
   * readable at a glance -- and matches exactly what the cars are obeying,
   * since both read the same phase function.
   */
  private drawSignals(
    sim: Simulation,
    view: { x0: number; y0: number; x1: number; y1: number },
  ): void {
    const { ctx, camera } = this;
    const z = camera.zoom;
    if (z < 6) return;

    const tick = sim.clock.tick;
    const r = Math.max(1.2, z * 0.11);

    for (const tile of sim.signals.signalTiles) {
      const x = tile % MAP_SIZE;
      const y = (tile / MAP_SIZE) | 0;
      if (x < view.x0 || x > view.x1 || y < view.y0 || y > view.y1) continue;

      const green = sim.signals.greenAxis(tile, tick);
      const p = camera.worldToScreen(x, y);
      const ns = green === SignalAxis.NorthSouth ? COLORS.signalGreen : COLORS.signalRed;
      const ew = green === SignalAxis.EastWest ? COLORS.signalGreen : COLORS.signalRed;

      dot(ctx, p.x + z * 0.5, p.y + z * 0.13, r, ns);
      dot(ctx, p.x + z * 0.5, p.y + z * 0.87, r, ns);
      dot(ctx, p.x + z * 0.13, p.y + z * 0.5, r, ew);
      dot(ctx, p.x + z * 0.87, p.y + z * 0.5, r, ew);
    }
  }

  /** How many people are standing on each platform, over the station itself. */
  /**
   * The buses, drawn in the colour of the line they work so a player can see
   * at a glance which service is stuck in which jam.
   */
  private drawBuses(sim: Simulation, alpha: number): void {
    const { ctx, camera } = this;
    const z = camera.zoom;
    if (z < 4) return;

    for (const bus of sim.world.buses) {
      if (bus.line < 0 || !bus.path) continue;
      const line = sim.world.lines[bus.line];
      if (!line) continue;
      const pose = agentPose(bus, alpha);
      const p = camera.worldToScreen(pose.x, pose.y);
      if (offScreen(camera, p, 12)) continue;

      const length = Math.max(5, z * 0.66);
      const width = Math.max(3, z * 0.34);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(pose.angle);
      ctx.fillStyle = COLORS.busBody;
      ctx.fillRect(-length / 2, -width / 2, length, width);
      // A stripe in the line's colour, and the load along it: a full bus and
      // an empty one are different things to the player watching a route.
      ctx.fillStyle = line.color;
      const load = Math.min(1, bus.passengers.length / BUS_CAPACITY);
      ctx.fillRect(-length / 2, -width / 2, length * load, width * 0.42);
      ctx.restore();
    }
  }

  /** Fire engines and patrol cars, with a light on when they are on a call. */
  private drawUnits(sim: Simulation, alpha: number): void {
    const { ctx, camera } = this;
    const z = camera.zoom;
    if (z < 4) return;

    for (const unit of sim.world.units) {
      if (!unit.path) continue;
      const pose = agentPose(unit, alpha);
      const p = camera.worldToScreen(pose.x, pose.y);
      if (offScreen(camera, p, 12)) continue;

      const length = Math.max(4, z * 0.5);
      const width = Math.max(3, z * 0.3);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(pose.angle);
      ctx.fillStyle = unit.kind === IncidentKind.Fire ? COLORS.fireEngine : COLORS.policeCar;
      ctx.fillRect(-length / 2, -width / 2, length, width);
      if (unit.state === UnitState.Responding) {
        ctx.fillStyle = COLORS.blueLight;
        ctx.fillRect(-length * 0.1, -width / 2, length * 0.2, width);
      }
      ctx.restore();
    }
  }

  private drawStationBadges(sim: Simulation): void {
    const z = this.camera.zoom;
    if (z < 7) return;

    for (const badge of this.stationBadges) {
      const waiting = sim.stats.waitingAt(badge.id);
      if (waiting === 0) continue;
      this.drawBadge(badge.x, badge.y - z * 0.35, `${waiting}人待ち`, z);
    }
  }

  /**
   * A warning sign floating over every building that has something wrong with
   * it, in the colour of how bad it is.
   *
   * This is the whole point of having diagnostics at all: a dark factory and a
   * working one used to look identical from above, so the only way to find the
   * failure was to click on buildings one at a time. The badges bob gently
   * because a static icon over a static building disappears into the map.
   */
  private drawIssueBadges(): void {
    const { ctx, camera } = this;
    const z = camera.zoom;
    if (z < 5 || this.issueBadges.length === 0) return;

    const size = Math.max(11, Math.min(22, z * 0.85));
    const bob = Math.sin(performance.now() / 380) * size * 0.08;

    for (const badge of this.issueBadges) {
      const style = BUILDING_ISSUES[badge.issue];
      const cx = badge.x;
      const cy = badge.y - size * 0.55 + bob;

      // A pin: a rounded chip with a little tail pointing at the building.
      ctx.fillStyle = TONE_COLORS[style.tone];
      ctx.beginPath();
      ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(cx - size * 0.18, cy + size * 0.34);
      ctx.lineTo(cx + size * 0.18, cy + size * 0.34);
      ctx.lineTo(cx, cy + size * 0.72);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = COLORS.alertText;
      ctx.font = `700 ${Math.round(size * 0.62)}px system-ui, "Noto Sans JP", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(style.icon, cx, cy + size * 0.03);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
    }
  }

  /** A ring around whatever the player asked the warnings panel to show them. */
  private drawFocus(tile: TileIndex): void {
    const { ctx, camera } = this;
    const p = camera.worldToScreen(tileCenterX(tile), tileCenterY(tile));
    const r = Math.max(10, camera.zoom * 0.9) + Math.sin(performance.now() / 240) * 3;
    ctx.strokeStyle = COLORS.alertCritical;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  /** A small dark chip with a number in it, sized off the zoom. */
  private drawBadge(
    cx: number,
    cy: number,
    text: string,
    z: number,
    background: string = COLORS.badgeBackground,
  ): void {
    const ctx = this.ctx;
    const fontSize = Math.max(9, Math.min(15, z * 0.7));
    ctx.font = `${fontSize}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const w = ctx.measureText(text).width + fontSize * 0.7;
    const h = fontSize * 1.35;
    ctx.fillStyle = background;
    ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
    ctx.fillStyle = background === COLORS.badgeBackground ? COLORS.badgeText : COLORS.alertText;
    ctx.fillText(text, cx, cy);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  /** Stations already picked in the line tool, so the player can see the plan. */
  /**
   * A fire or a burglary in progress, over the building it is happening to.
   *
   * Deliberately louder than the warning badges: one of these has a clock on
   * it, and the player is being asked to act now rather than to plan better.
   */
  private drawAlarmBadges(): void {
    const z = this.camera.zoom;
    if (z < 6) return;
    for (const badge of this.alarmBadges) {
      const fire = badge.kind === IncidentKind.Fire;
      this.drawBadge(
        badge.x,
        badge.y - Math.max(6, z * 0.32),
        fire ? '火' : '盗',
        z,
        fire ? COLORS.alertCritical : COLORS.alertWarning,
      );
    }
  }

  private drawPendingStations(sim: Simulation, opts: RenderOptions): void {
    if (opts.pendingStations.length === 0) return;
    const { ctx, camera } = this;
    ctx.strokeStyle = COLORS.stationPending;
    ctx.lineWidth = 2;
    opts.pendingStations.forEach((id, order) => {
      const b = sim.world.buildings[id];
      if (!b) return;
      const p = camera.worldToScreen(tileCenterX(b.tile), tileCenterY(b.tile));
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(7, camera.zoom * 0.7), 0, Math.PI * 2);
      ctx.stroke();
      if (camera.zoom >= 8) {
        ctx.fillStyle = COLORS.stationPending;
        ctx.font = `${Math.round(camera.zoom * 0.8)}px system-ui`;
        ctx.fillText(String(order + 1), p.x + camera.zoom * 0.8, p.y - camera.zoom * 0.5);
      }
    });
  }

  private drawHover(tile: TileIndex): void {
    const { ctx, camera } = this;
    const p = camera.worldToScreen(tileCenterX(tile) - 0.5, tileCenterY(tile) - 0.5);
    ctx.strokeStyle = COLORS.hover;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(p.x, p.y, camera.zoom, camera.zoom);
  }
}

interface Pose {
  x: number;
  y: number;
  /** Rotation in radians, pointing the way the agent is travelling. */
  angle: number;
}

/**
 * Where to draw an agent and which way to point it.
 *
 * The heading comes from the route rather than from the last frame's movement:
 * a car stopped at a red light has not moved, and a car that has just entered
 * a tile has moved a rounding error, so motion-derived headings flicker
 * exactly when the player is looking closest. The route knows the answer even
 * when the car is stationary.
 *
 * The lane offset is that heading turned ninety degrees to the left. Traffic
 * keeps left, so the two directions never overlap on the same tile.
 */
/** Whether a screen point is far enough outside the viewport to skip. */
function offScreen(camera: Camera, p: { x: number; y: number }, margin: number): boolean {
  return p.x < -margin || p.y < -margin
    || p.x > camera.viewportWidth + margin || p.y > camera.viewportHeight + margin;
}

export function agentPose(c: RoadAgent, alpha: number): Pose {
  const x = c.prevX + (c.x - c.prevX) * alpha;
  const y = c.prevY + (c.y - c.prevY) * alpha;

  const heading = headingVector(c);
  if (!heading) return { x, y, angle: 0 };

  const offset = c.mode === TravelMode.Car ? LANE_OFFSET : WALK_LANE_OFFSET;
  return {
    // Left of the heading in screen space, where y grows downwards.
    x: x + heading.dy * offset,
    y: y - heading.dx * offset,
    angle: Math.atan2(heading.dy, heading.dx),
  };
}

function headingVector(c: RoadAgent): { dx: number; dy: number } | null {
  const path = c.path;
  if (path && path.length >= 2) {
    const seg = Math.min(path.length - 2, Math.max(0, Math.floor(c.s)));
    const dx = tileCenterX(path[seg + 1]) - tileCenterX(path[seg]);
    const dy = tileCenterY(path[seg + 1]) - tileCenterY(path[seg]);
    if (dx !== 0 || dy !== 0) return { dx, dy };
  }
  const dx = c.x - c.prevX;
  const dy = c.y - c.prevY;
  const len = Math.hypot(dx, dy);
  return len > 1e-6 ? { dx: dx / len, dy: dy / len } : null;
}

function dot(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  color: string,
): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

/** Face the train along its current motion, so the body reads as a train. */
function trainHeading(train: Train): number {
  const dx = train.x - train.prevX;
  const dy = train.y - train.prevY;
  if (dx === 0 && dy === 0) return 0;
  return Math.atan2(dy, dx);
}

function groundColor(resource: Resource, x: number, y: number): string {
  switch (resource) {
    case Resource.Forest:
      return COLORS.forestGround;
    case Resource.Ore:
      return COLORS.oreGround;
    case Resource.Fertile:
      return COLORS.fertileGround;
    case Resource.None:
      return (x + y) % 2 === 0 ? COLORS.grass : COLORS.grassAlt;
  }
}

const ZONE_COLORS: Record<Zone, string> = {
  [Zone.None]: 'transparent',
  [Zone.ResidentialLow]: COLORS.zoneResidentialLow,
  [Zone.ResidentialHigh]: COLORS.zoneResidentialHigh,
  [Zone.Commercial]: COLORS.zoneCommercial,
  [Zone.Industrial]: COLORS.zoneIndustrial,
  [Zone.Office]: COLORS.zoneOffice,
  [Zone.Farm]: COLORS.zoneFarm,
  [Zone.Forestry]: COLORS.zoneForestry,
  [Zone.Fishery]: COLORS.zoneFishery,
  [Zone.Mining]: COLORS.zoneMining,
};

const BUILDING_COLORS: Record<BuildingType, string> = {
  [BuildingType.BusStop]: COLORS.busStop,
  [BuildingType.School]: COLORS.school,
  [BuildingType.FireStation]: COLORS.fireStation,
  [BuildingType.PoliceStation]: COLORS.policeStation,
  [BuildingType.House]: COLORS.residence,
  [BuildingType.Apartment]: COLORS.apartment,
  [BuildingType.Shop]: COLORS.commerce,
  [BuildingType.Factory]: COLORS.industry,
  [BuildingType.Office]: COLORS.office,
  [BuildingType.Farm]: COLORS.farm,
  [BuildingType.ForestryCamp]: COLORS.forestry,
  [BuildingType.FishingWharf]: COLORS.fishery,
  [BuildingType.Mine]: COLORS.mining,
  [BuildingType.Station]: COLORS.station,
  [BuildingType.PowerPlant]: COLORS.power,
};

/** Warning colours, keyed by the severity the diagnostics reported. */
const TONE_COLORS: Record<'critical' | 'warning' | 'info', string> = {
  critical: COLORS.alertCritical,
  warning: COLORS.alertWarning,
  info: COLORS.alertInfo,
};
