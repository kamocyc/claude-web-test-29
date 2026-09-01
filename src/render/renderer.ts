import { CAR_FREE_SPEED, TRAIN_CAPACITY, TRAIN_LENGTH } from '../config';
import { idx } from '../core/grid';
import {
  BuildingType,
  CitizenState,
  Terrain,
  TravelMode,
  Zone,
  type TileIndex,
} from '../core/types';
import type { Citizen } from '../sim/citizen';
import { tileCenterX, tileCenterY } from '../sim/citizen';
import type { Simulation } from '../sim/simulation';
import { COLORS, speedColor } from './palette';
import type { Camera } from './camera';
import type { Train } from '../world/transit';

export interface RenderOptions {
  showZones: boolean;
  showTraffic: boolean;
  hoverTile: TileIndex;
  selected: Citizen | null;
  /** Stations picked so far in the line tool, highlighted while choosing. */
  pendingStations: readonly number[];
}

export class Renderer {
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
    this.drawTiles(sim, view, opts);
    this.drawLines(sim);
    this.drawAgents(sim, alpha, opts);
    this.drawTrains(sim, alpha);
    this.drawPendingStations(sim, opts);
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
          ctx.fillStyle = (x + y) % 2 === 0 ? COLORS.grass : COLORS.grassAlt;
        }
        ctx.fillRect(p.x, p.y, size, size);
        if (map.rail[i] === 1 && z >= 7) this.drawSleepers(p.x, p.y, z);
        if (map.isCrossing(i)) this.drawCrossing(sim, i, p.x, p.y, z);

        const bid = map.building[i];
        if (bid !== -1) {
          const b = sim.world.buildings[bid];
          if (b && sim.world.isAlive(b)) {
            const fill = b.capacity > 0 ? b.occupants.length / b.capacity : 1;
            this.drawBuilding(p.x, p.y, z, b.type, fill);
          }
        } else if (opts.showZones && map.zone[i] !== Zone.None) {
          ctx.fillStyle = map.zone[i] === Zone.Residential
            ? COLORS.zoneResidential
            : COLORS.zoneCommercial;
          ctx.fillRect(p.x, p.y, size, size);
        }

        if (opts.showTraffic && map.road[i] === 1) {
          this.drawTrafficTile(sim, i, p.x, p.y, size);
        }
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

  /** Traffic colour is the mean speed ratio of the cars actually on the tile. */
  private drawTrafficTile(sim: Simulation, tile: TileIndex, px: number, py: number, size: number): void {
    const occupants = sim.occupancy.at(tile);
    if (occupants.length === 0) return;

    let sum = 0;
    for (const o of occupants) {
      const c = sim.world.citizens[o.id];
      if (c) sum += c.v / CAR_FREE_SPEED;
    }
    const ratio = sum / occupants.length;

    this.ctx.globalAlpha = 0.35;
    this.ctx.fillStyle = speedColor(ratio);
    this.ctx.fillRect(px, py, size, size);
    this.ctx.globalAlpha = 1;
  }

  private drawAgents(sim: Simulation, alpha: number, opts: RenderOptions): void {
    const { ctx, camera } = this;
    const z = camera.zoom;
    // Below this zoom individual dots are sub-pixel noise, so thin them out.
    const stride = z < 6 ? 3 : 1;
    const carSize = Math.max(2, z * 0.3);
    const walkSize = Math.max(1.5, z * 0.18);

    for (let i = 0; i < sim.world.citizens.length; i += stride) {
      const c = sim.world.citizens[i];
      if (c.state === CitizenState.AtHome || c.state === CitizenState.AtWork) continue;
      // Riders are inside the train, which is drawn separately; their dots
      // would just pile up on top of it.
      if (c.state === CitizenState.Riding) continue;

      const x = c.prevX + (c.x - c.prevX) * alpha;
      const y = c.prevY + (c.y - c.prevY) * alpha;
      const p = camera.worldToScreen(x, y);
      if (p.x < -8 || p.y < -8 || p.x > camera.viewportWidth + 8 || p.y > camera.viewportHeight + 8) {
        continue;
      }

      if (c.state === CitizenState.Stranded) {
        ctx.fillStyle = COLORS.stranded;
      } else if (c.mode === TravelMode.Car) {
        ctx.fillStyle = speedColor(c.v / CAR_FREE_SPEED);
      } else {
        ctx.fillStyle = COLORS.pedestrian;
      }

      const s = c.mode === TravelMode.Car ? carSize : walkSize;
      ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
    }

    if (opts.selected) this.drawPath(sim, opts.selected);
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
    const x = c.prevX + (c.x - c.prevX) * alpha;
    const y = c.prevY + (c.y - c.prevY) * alpha;
    const p = camera.worldToScreen(x, y);
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
      ctx.beginPath();
      for (let i = 0; i < line.route.length; i++) {
        const p = camera.worldToScreen(tileCenterX(line.route[i]), tileCenterY(line.route[i]));
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
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
    }
  }

  /** Stations already picked in the line tool, so the player can see the plan. */
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

/** Face the train along its current motion, so the body reads as a train. */
function trainHeading(train: Train): number {
  const dx = train.x - train.prevX;
  const dy = train.y - train.prevY;
  if (dx === 0 && dy === 0) return 0;
  return Math.atan2(dy, dx);
}

const BUILDING_COLORS: Record<BuildingType, string> = {
  [BuildingType.Residence]: COLORS.residence,
  [BuildingType.Commerce]: COLORS.commerce,
  [BuildingType.Station]: COLORS.station,
};
