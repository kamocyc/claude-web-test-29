import { idx } from './core/grid';
import { BuildingType, CitizenState, Zone, type BuildingId, type TileIndex } from './core/types';
import { Camera } from './render/camera';
import { Renderer } from './render/renderer';
import type { Citizen } from './sim/citizen';
import { Simulation } from './sim/simulation';
import { attachInput } from './ui/input';
import { Hud } from './ui/hud';
import { Inspector } from './ui/inspector';
import { applyTool, isDragTool, Tool, TOOL_BY_KEY } from './ui/tools';
import { createLine } from './world/lineBuilder';
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

/** Stations picked so far with the line tool, in order. */
let pendingStations: BuildingId[] = [];
let notice = '';
let noticeUntil = 0;

function say(message: string): void {
  notice = message;
  noticeUntil = performance.now() + 4000;
}

const hud = new Hud(hudRoot, {
  onTool: (t) => {
    tool = t;
    if (t !== Tool.Line) pendingStations = [];
  },
  onSpeed: (i) => sim.clock.setSpeedIndex(i),
  onToggleZones: () => (showZones = !showZones),
  onToggleTraffic: () => (showTraffic = !showTraffic),
  onPickRandom: pickRandomCitizen,
  onCommitLine: commitLine,
  onCancelLine: () => {
    pendingStations = [];
  },
});

seedStartingTown();
camera.centerOn(92, 64);

attachInput(canvas, camera, {
  onPaint: (tile) => {
    if (tool === Tool.Line) {
      pickStation(tile);
      return;
    }
    if (tool === Tool.Select) return;
    if (tool === Tool.Station && !applyTool(world, tool, tile)) {
      say('駅は線路と道路の両方に接するタイルにしか置けません');
      return;
    }
    applyTool(world, tool, tile);
  },
  onSelectAt: (wx, wy) => {
    if (tool === Tool.Select) selectNearestCitizen(wx, wy);
  },
  onHover: (tile) => (hoverTile = tile),
  onSpeedKey: (i) => sim.clock.setSpeedIndex(i),
  onToolKey: (key) => {
    const next = TOOL_BY_KEY[key];
    if (!next) return;
    tool = next;
    if (next !== Tool.Line) pendingStations = [];
  },
  onToggleZones: () => (showZones = !showZones),
  onToggleTraffic: () => (showTraffic = !showTraffic),
  isDragging: () => isDragTool(tool),
});

/** Append a clicked station to the line being built, or remove it if repeated. */
function pickStation(tile: TileIndex): void {
  const id = world.map.building[tile];
  const b = id >= 0 ? world.buildings[id] : undefined;
  if (!b || !b.alive || b.type !== BuildingType.Station) {
    say('駅をクリックしてください');
    return;
  }
  const at = pendingStations.lastIndexOf(b.id);
  if (at === pendingStations.length - 1 && at >= 0) {
    pendingStations.pop();
    return;
  }
  pendingStations.push(b.id);
}

function commitLine(): void {
  if (pendingStations.length < 2) {
    say('路線には2駅以上必要です');
    return;
  }
  const line = createLine(world, pendingStations);
  if (!line) {
    say('駅どうしが線路で繋がっていません');
    return;
  }
  say(`${line.name}を開業しました`);
  pendingStations = [];
}

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
    (c) => c.state !== CitizenState.AtHome && c.state !== CitizenState.AtWork,
  );
  const pool = travelling.length > 0 ? travelling : world.citizens;
  if (pool.length === 0) return;
  const c = pool[Math.floor(Math.random() * pool.length)];
  inspector.select(c);
  camera.centerOn(c.x, c.y);
}

/**
 * The opening scenario: two districts -- housing in the west, workplaces in
 * the east -- separated by a gap that only two roads and one railway cross.
 *
 * The shape is the point. A uniform grid has spare capacity everywhere, so
 * nothing ever jams and driving always wins; the interesting decisions only
 * appear once the connection between where people live and where they work is
 * the scarce thing. Here the corridor congests at rush hour, and that is
 * exactly when the train starts winning the comparison.
 */
function seedStartingTown(): void {
  const BLOCK = 5;
  const top = 44;
  const height = 40;
  const west = { x: 60, w: 25 };
  const east = { x: 99, w: 25 };
  // Two rows clear of the street at top+20: a station needs a free tile that
  // touches track on one side and pavement on the other, and that gap is the
  // only place such a tile exists.
  const railRow = top + 18;
  const linkRows = [top + 7, top + 32];

  const district = (d: { x: number; w: number }, zone: Zone): void => {
    for (let dy = 0; dy <= height; dy += BLOCK) {
      for (let k = 0; k <= d.w; k++) world.placeRoad(idx(d.x + k, top + dy));
    }
    for (let dx = 0; dx <= d.w; dx += BLOCK) {
      for (let k = 0; k <= height; k++) world.placeRoad(idx(d.x + dx, top + k));
    }
    for (let x = d.x; x <= d.x + d.w; x++) {
      for (let y = top; y <= top + height; y++) {
        const tile = idx(x, y);
        if (world.adjacentRoad(tile) >= 0) world.paintZone(tile, zone);
      }
    }
  };

  district(west, Zone.Residential);
  district(east, Zone.Commercial);

  // Two road links across the gap. Everything drives through these, which is
  // what makes them back up.
  for (const y of linkRows) {
    for (let x = west.x + west.w; x <= east.x; x++) world.placeRoad(idx(x, y));
  }

  // The railway goes down last, so every street it meets becomes a level
  // crossing rather than a gap in the line.
  for (let x = west.x + 2; x <= east.x + east.w - 2; x++) {
    world.placeRail(idx(x, railRow));
  }

  // Two stations per district, on x values off the 5-tile street grid so the
  // tile is free, sitting right among the blocks they serve. Siting is what
  // makes a line worth riding: put a station where nobody lives and the walk
  // to it eats the time the train saves.
  const stations: BuildingId[] = [];
  for (const x of [west.x + 8, west.x + 18, east.x + 7, east.x + 17]) {
    const station = world.placeStation(idx(x, railRow + 1));
    if (station) stations.push(station.id);
  }
  createLine(world, stations);
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
    pendingStations,
  });

  if (now > noticeUntil) notice = '';
  hud.update(sim, tool, pendingStations, notice);
  inspector.update(sim);

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
