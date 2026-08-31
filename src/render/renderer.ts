import { CAR_FREE_SPEED } from '../config';
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

export interface RenderOptions {
  showZones: boolean;
  showTraffic: boolean;
  hoverTile: TileIndex;
  selected: Citizen | null;
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
    this.drawAgents(sim, alpha, opts);
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
        } else {
          ctx.fillStyle = (x + y) % 2 === 0 ? COLORS.grass : COLORS.grassAlt;
        }
        ctx.fillRect(p.x, p.y, size, size);

        const bid = map.building[i];
        if (bid !== -1) {
          const b = sim.world.buildings[bid];
          if (b && sim.world.isAlive(b)) this.drawBuilding(p.x, p.y, z, b.type, b.occupants.length / b.capacity);
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
    ctx.fillStyle = type === BuildingType.Residence ? COLORS.residence : COLORS.commerce;
    ctx.globalAlpha = 0.45 + 0.55 * Math.min(1, fill);
    ctx.fillRect(px + inset, py + inset, z - inset * 2, z - inset * 2);
    ctx.globalAlpha = 1;
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

    if (opts.selected) this.drawPath(opts.selected);
  }

  private drawPath(c: Citizen): void {
    if (!c.path) return;
    const { ctx, camera } = this;
    ctx.strokeStyle = COLORS.path;
    ctx.lineWidth = Math.max(1, camera.zoom * 0.12);
    ctx.beginPath();
    for (let i = 0; i < c.path.length; i++) {
      const p = camera.worldToScreen(tileCenterX(c.path[i]), tileCenterY(c.path[i]));
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

  private drawHover(tile: TileIndex): void {
    const { ctx, camera } = this;
    const p = camera.worldToScreen(tileCenterX(tile) - 0.5, tileCenterY(tile) - 0.5);
    ctx.strokeStyle = COLORS.hover;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(p.x, p.y, camera.zoom, camera.zoom);
  }
}
