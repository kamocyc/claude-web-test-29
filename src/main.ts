import { idx } from './core/grid';
import { CitizenState, Zone, type TileIndex } from './core/types';
import { Camera } from './render/camera';
import { Renderer } from './render/renderer';
import type { Citizen } from './sim/citizen';
import { Simulation } from './sim/simulation';
import { attachInput } from './ui/input';
import { Hud } from './ui/hud';
import { Inspector } from './ui/inspector';
import { applyTool, Tool } from './ui/tools';
import { World } from './world/world';

const canvas = document.getElementById('map') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const hudRoot = document.getElementById('hud')!;
const inspectorRoot = document.getElementById('inspector')!;

const world = new World(20260831);
const sim = new Simulation(world);
const camera = new Camera();
const renderer = new Renderer(ctx, camera);
const inspector = new Inspector(inspectorRoot);

let tool: Tool = Tool.Road;
let showZones = true;
let showTraffic = true;
let hoverTile: TileIndex = -1;

const hud = new Hud(hudRoot, {
  onTool: (t) => (tool = t),
  onSpeed: (i) => sim.clock.setSpeedIndex(i),
  onToggleZones: () => (showZones = !showZones),
  onToggleTraffic: () => (showTraffic = !showTraffic),
  onPickRandom: pickRandomCitizen,
});

seedStartingTown();
camera.centerOn(88, 62);

attachInput(canvas, camera, {
  onPaint: (tile) => {
    if (tool !== Tool.Select) applyTool(world, tool, tile);
  },
  onSelectAt: selectNearestCitizen,
  onHover: (tile) => (hoverTile = tile),
  onSpeedKey: (i) => sim.clock.setSpeedIndex(i),
  onToolKey: (key) => {
    const map: Record<string, Tool> = {
      '1': Tool.Select,
      '2': Tool.Road,
      '3': Tool.Residential,
      '4': Tool.Commercial,
      '5': Tool.Bulldoze,
    };
    if (map[key]) tool = map[key];
  },
  onToggleZones: () => (showZones = !showZones),
  onToggleTraffic: () => (showTraffic = !showTraffic),
});

function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  camera.resize(w, h);
}
window.addEventListener('resize', resize);
resize();

/** Clicking picks the closest travelling citizen within a forgiving radius. */
function selectNearestCitizen(wx: number, wy: number): void {
  const radius = Math.max(1.5, 24 / camera.zoom);
  let best: Citizen | null = null;
  let bestDist = radius * radius;

  for (const c of world.citizens) {
    if (c.state === CitizenState.AtHome || c.state === CitizenState.AtWork) continue;
    const dx = c.x - wx;
    const dy = c.y - wy;
    const d = dx * dx + dy * dy;
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  if (best) inspector.select(best);
}

function pickRandomCitizen(): void {
  const travelling = world.citizens.filter(
    (c) => c.state === CitizenState.ToWork || c.state === CitizenState.ToHome,
  );
  const pool = travelling.length > 0 ? travelling : world.citizens;
  if (pool.length === 0) return;
  const c = pool[Math.floor(Math.random() * pool.length)];
  inspector.select(c);
  camera.centerOn(c.x, c.y);
}

/**
 * A small starter grid so the first frame is a town rather than an empty
 * field -- the sim is much easier to judge when something is already moving.
 */
function seedStartingTown(): void {
  const x0 = 68;
  const y0 = 42;
  const span = 40;
  // Blocks of four. Tight enough that nearly every zoned tile touches a road,
  // which is what lets the city actually fill in rather than stall as soon as
  // the frontage is used up.
  const BLOCK = 5;

  for (let d = 0; d <= span; d += BLOCK) {
    for (let k = 0; k <= span; k++) {
      world.placeRoad(idx(x0 + d, y0 + k));
      world.placeRoad(idx(x0 + k, y0 + d));
    }
  }

  const split = x0 + span / 2;
  for (let x = x0; x <= x0 + span; x++) {
    for (let y = y0; y <= y0 + span; y++) {
      const tile = idx(x, y);
      if (world.adjacentRoad(tile) < 0) continue;
      // Housing west of the middle avenue, workplaces east of it, so the
      // morning rush has a direction and the arterials actually load up.
      world.paintZone(tile, x < split ? Zone.Residential : Zone.Commercial);
    }
  }
}

let lastTime = performance.now();

function frame(now: number): void {
  const dt = Math.min(0.25, (now - lastTime) / 1000);
  lastTime = now;

  const ticks = sim.clock.advance(dt);
  for (let i = 0; i < ticks; i++) sim.tick();

  if (inspector.following && inspector.selected) {
    camera.centerOn(inspector.selected.x, inspector.selected.y);
  }

  renderer.draw(sim, sim.clock.alpha, {
    showZones,
    showTraffic,
    hoverTile,
    selected: inspector.selected,
  });

  hud.update(sim, tool);
  inspector.update(sim);

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
