import { idx, inBounds } from '../core/grid';
import type { TileIndex } from '../core/types';
import type { Camera } from '../render/camera';
import type { Overlay } from '../render/renderer';

export interface InputHandlers {
  onPaint(tile: TileIndex): void;
  onSelectAt(worldX: number, worldY: number): void;
  onHover(tile: TileIndex): void;
  onSpeedKey(index: number): void;
  onToolKey(key: string): void;
  /** Whether the active tool paints on drag, checked at drag time. */
  isDragging(): boolean;
  onToggleZones(): void;
  onOverlayKey(overlay: Overlay): void;
}

/**
 * Left drag paints with the active tool, right drag (or space+drag) pans.
 * Painting on drag rather than on click is what makes laying a road feel like
 * drawing rather than clicking 40 times.
 */
export function attachInput(
  canvas: HTMLCanvasElement,
  camera: Camera,
  handlers: InputHandlers,
): void {
  let painting = false;
  let panning = false;
  let lastX = 0;
  let lastY = 0;
  let movedWhilePainting = false;

  const tileAt = (e: MouseEvent): TileIndex => {
    const rect = canvas.getBoundingClientRect();
    const w = camera.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    const x = Math.floor(w.x);
    const y = Math.floor(w.y);
    return inBounds(x, y) ? idx(x, y) : -1;
  };

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('mousedown', (e) => {
    lastX = e.clientX;
    lastY = e.clientY;
    if (e.button === 2 || e.button === 1) {
      panning = true;
      return;
    }
    painting = true;
    movedWhilePainting = false;
    const tile = tileAt(e);
    if (tile >= 0) handlers.onPaint(tile);
  });

  window.addEventListener('mousemove', (e) => {
    if (panning) {
      camera.panByPixels(e.clientX - lastX, e.clientY - lastY);
      lastX = e.clientX;
      lastY = e.clientY;
      return;
    }
    // The toolbar and the information windows float over the map, so a
    // pointer on one of them is not pointing at a tile: highlighting the tile
    // hidden underneath a panel is worse than highlighting nothing.
    const overMap = e.target === canvas;
    const tile = tileAt(e);
    handlers.onHover(overMap ? tile : -1);
    if (painting && handlers.isDragging()) {
      movedWhilePainting = true;
      if (tile >= 0) handlers.onPaint(tile);
    }
  });

  window.addEventListener('mouseup', (e) => {
    if (painting && !movedWhilePainting) {
      const rect = canvas.getBoundingClientRect();
      const w = camera.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      handlers.onSelectAt(w.x, w.y);
    }
    painting = false;
    panning = false;
  });

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      camera.zoomAt(
        e.clientX - rect.left,
        e.clientY - rect.top,
        e.deltaY < 0 ? 1.12 : 1 / 1.12,
      );
    },
    { passive: false },
  );

  window.addEventListener('keydown', (e) => {
    // A shortcut typed into a field is text, not a command.
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;

    const key = e.key.toLowerCase();
    const overlay = OVERLAY_KEYS[key];
    if (overlay) {
      handlers.onOverlayKey(overlay);
      return;
    }
    if (key === ' ') {
      e.preventDefault();
      handlers.onSpeedKey(0);
      return;
    }
    if (key === 'z') {
      handlers.onToggleZones();
      return;
    }
    handlers.onToolKey(key);
  });
}

/** Overlay shortcuts, kept out of the tool table so they cannot collide. */
const OVERLAY_KEYS: Readonly<Record<string, Overlay>> = {
  '0': 'none',
  t: 'traffic',
  p: 'power',
  n: 'noise',
  v: 'landValue',
  c: 'crime',
  b: 'services',
  m: 'height',
};
