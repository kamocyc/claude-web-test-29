import { MAP_SIZE } from '../config';
import type { Vec2 } from '../core/types';

const MIN_ZOOM = 3;
const MAX_ZOOM = 40;

/** Pixels per tile at zoom 1 is simply `zoom`, so zoom doubles as tile size. */
export class Camera {
  /** World position (in tiles) at the centre of the viewport. */
  x = MAP_SIZE / 2;
  y = MAP_SIZE / 2;
  zoom = 12;

  viewportWidth = 1;
  viewportHeight = 1;

  resize(w: number, h: number): void {
    this.viewportWidth = w;
    this.viewportHeight = h;
  }

  worldToScreen(wx: number, wy: number): Vec2 {
    return {
      x: (wx - this.x) * this.zoom + this.viewportWidth / 2,
      y: (wy - this.y) * this.zoom + this.viewportHeight / 2,
    };
  }

  screenToWorld(sx: number, sy: number): Vec2 {
    return {
      x: (sx - this.viewportWidth / 2) / this.zoom + this.x,
      y: (sy - this.viewportHeight / 2) / this.zoom + this.y,
    };
  }

  panByPixels(dxPx: number, dyPx: number): void {
    this.x -= dxPx / this.zoom;
    this.y -= dyPx / this.zoom;
    this.clamp();
  }

  centerOn(wx: number, wy: number): void {
    this.x = wx;
    this.y = wy;
    this.clamp();
  }

  /** Zoom about a screen point, so the tile under the cursor stays put. */
  zoomAt(sx: number, sy: number, factor: number): void {
    const before = this.screenToWorld(sx, sy);
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * factor));
    const after = this.screenToWorld(sx, sy);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
    this.clamp();
  }

  /** Tile range covering the viewport, for draw culling. */
  visibleTiles(): { x0: number; y0: number; x1: number; y1: number } {
    const tl = this.screenToWorld(0, 0);
    const br = this.screenToWorld(this.viewportWidth, this.viewportHeight);
    return {
      x0: Math.max(0, Math.floor(tl.x) - 1),
      y0: Math.max(0, Math.floor(tl.y) - 1),
      x1: Math.min(MAP_SIZE - 1, Math.ceil(br.x) + 1),
      y1: Math.min(MAP_SIZE - 1, Math.ceil(br.y) + 1),
    };
  }

  private clamp(): void {
    this.x = Math.min(MAP_SIZE, Math.max(0, this.x));
    this.y = Math.min(MAP_SIZE, Math.max(0, this.y));
  }
}
