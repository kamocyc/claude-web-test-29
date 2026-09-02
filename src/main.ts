import { idx, manhattan, tileX, tileY } from './core/grid';
import {
  BuildingType,
  isAtRest,
  Resource,
  Zone,
  type BuildingId,
  type TileIndex,
} from './core/types';
import { Camera } from './render/camera';
import { Renderer } from './render/renderer';
import type { Citizen } from './sim/citizen';
import type { Lorry } from './sim/lorry';
import { Simulation } from './sim/simulation';
import { attachInput } from './ui/input';
import { Hud } from './ui/hud';
import { Inspector } from './ui/inspector';
import { StatsPanel } from './ui/stats';
import { applyTool, isDragTool, Tool, TOOL_BY_KEY } from './ui/tools';
import { BudgetPanel } from './ui/budget';
import type { Overlay } from './render/renderer';
import { createLine, createLineThrough } from './world/lineBuilder';
import { findPath } from './sim/pathfinding';
import { hasSavedCity, loadFromStorage, saveToStorage } from './world/persistence';
import { World } from './world/world';

const canvas = document.getElementById('map') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const hudRoot = document.getElementById('hud')!;
const inspectorRoot = document.getElementById('inspector')!;
const statsRoot = document.getElementById('stats')!;
const budgetRoot = document.getElementById('budget')!;

/**
 * The simulation is a `let` rather than a `const` because loading a save
 * replaces it wholesale. Rebuilding is what makes a load safe: every id in the
 * sim is an array index, so patching a live city in place would leave the
 * panels pointing at citizens that no longer exist.
 */
let sim = new Simulation(new World(20260831));
const camera = new Camera();
const renderer = new Renderer(ctx, camera);
const inspector = new Inspector(inspectorRoot);
const statsPanel = new StatsPanel(statsRoot);
const budgetPanel = new BudgetPanel(budgetRoot, {
  onRate: (category, delta) => sim.economy.setRate(category, sim.economy.rates[category] + delta),
  onBorrow: () => say(sim.economy.borrow() ? '借入しました' : 'これ以上は借りられません'),
  onRepay: () => say(sim.economy.repay() ? '返済しました' : '返済できる残高がありません'),
});

let tool: Tool = Tool.Road;
let showZones = true;
let overlay: Overlay = 'none';
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
  onOverlay: (o) => (overlay = overlay === o ? 'none' : o),
  onPickRandom: pickRandomCitizen,
  onCommitLine: commitLine,
  onCancelLine: () => {
    pendingStations = [];
  },
  onSave: saveCity,
  onLoad: loadCity,
});
hud.setSaveAvailable(hasSavedCity());

seedStartingTown();
camera.centerOn(92, 64);

attachInput(canvas, camera, {
  onPaint: (tile) => {
    if (tool === Tool.Line) {
      pickStation(tile);
      return;
    }
    if (tool === Tool.Select) return;
    const result = applyTool(sim.world, sim.economy, tool, tile);
    if (!result.applied && result.message) say(result.message);
  },
  onSelectAt: (wx, wy) => {
    if (tool === Tool.Select) selectAt(wx, wy);
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
  onOverlayKey: (o) => (overlay = overlay === o ? 'none' : o),
  isDragging: () => isDragTool(tool),
});

/** Append a clicked station to the line being built, or remove it if repeated. */
function pickStation(tile: TileIndex): void {
  const id = sim.world.map.building[tile];
  const b = id >= 0 ? sim.world.buildings[id] : undefined;
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

/**
 * Open a service through the stations the player picked, in that order,
 * laying whatever track is missing between them.
 */
function commitLine(): void {
  if (pendingStations.length < 2) {
    say('路線には2駅以上必要です');
    return;
  }
  const { line, builtTrack } = createLineThrough(sim.world, pendingStations);
  if (!line) {
    say('駅どうしを結ぶ線路を敷けません（水面や建物が邪魔をしています）');
    return;
  }
  say(
    builtTrack
      ? `${line.name}を開業しました（不足していた線路を敷設しました）`
      : `${line.name}を開業しました`,
  );
  pendingStations = [];
}

// --- Save / load -----------------------------------------------------------

function saveCity(): void {
  try {
    saveToStorage(sim);
    hud.setSaveAvailable(true);
    say('この街を保存しました');
  } catch (e) {
    say(e instanceof Error ? e.message : '保存に失敗しました');
  }
}

function loadCity(): void {
  try {
    const loaded = loadFromStorage();
    if (!loaded) {
      say('保存された街がありません');
      return;
    }
    // The clock speed is a viewing preference, not part of the city: keep
    // whatever the player was watching at.
    loaded.clock.setSpeedIndex(sim.clock.speedIndex);
    sim = loaded;
    pendingStations = [];
    inspector.clear();
    say('保存した街を読み込みました');
  } catch (e) {
    say(e instanceof Error ? e.message : '読み込みに失敗しました');
  }
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

/** A click picks the building under the cursor, or else the nearest traveller. */
function selectAt(wx: number, wy: number): void {
  const tile = sim.world.map.at(Math.floor(wx), Math.floor(wy));
  const bid = tile >= 0 ? sim.world.map.building[tile] : -1;
  const building = bid >= 0 ? sim.world.buildings[bid] : undefined;
  if (building && building.alive) {
    inspector.selectStation(building);
    return;
  }
  selectNearestCitizen(wx, wy);
}

/**
 * Clicking picks the closest road user within a forgiving radius -- a lorry
 * counts, because a delivery running late is as much worth following as a
 * commuter stuck in the same queue.
 */
function selectNearestCitizen(wx: number, wy: number): void {
  const radius = Math.max(1.5, 24 / camera.zoom);
  let bestDist = radius * radius;
  let bestCitizen: Citizen | null = null;
  let bestLorry: Lorry | null = null;

  const consider = (x: number, y: number): number => {
    const dx = x - wx;
    const dy = y - wy;
    return dx * dx + dy * dy;
  };

  for (const c of sim.world.citizens) {
    if (isAtRest(c.state)) continue;
    const d = consider(c.x, c.y);
    if (d < bestDist) {
      bestDist = d;
      bestCitizen = c;
      bestLorry = null;
    }
  }
  for (const l of sim.world.lorries) {
    if (!l.path) continue;
    const d = consider(l.x, l.y);
    if (d < bestDist) {
      bestDist = d;
      bestLorry = l;
      bestCitizen = null;
    }
  }

  if (bestLorry) inspector.selectLorry(bestLorry);
  else if (bestCitizen) inspector.select(bestCitizen);
}

function pickRandomCitizen(): void {
  const travelling = sim.world.citizens.filter(
    (c) => !isAtRest(c.state),
  );
  const pool = travelling.length > 0 ? travelling : sim.world.citizens;
  if (pool.length === 0) return;
  const c = pool[Math.floor(Math.random() * pool.length)];
  inspector.select(c);
  camera.centerOn(c.x, c.y);
}

/**
 * The opening scenario: two districts -- housing in the west, workplaces in
 * the east -- separated by a gap that only two roads and one railway cross,
 * with a power station, a small industrial strip, and whatever primary
 * industry the ground nearby happens to support.
 *
 * The shape is the point. A uniform grid has spare capacity everywhere, so
 * nothing ever jams and driving always wins; the interesting decisions only
 * appear once the connection between where people live and where they work is
 * the scarce thing. Here the corridor congests at rush hour, and that is
 * exactly when the train starts winning the comparison.
 *
 * The town is deliberately started *incomplete*: it has enough of a supply
 * chain to be alive and not enough to stay that way, so the first thing the
 * player has to do is find the fertile ground, the woods or the seam, and
 * connect them.
 */
function seedStartingTown(): void {
  const world = sim.world;
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

  district(west, Zone.ResidentialLow);
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

  // Industry along the southern edge of the commercial district, downwind of
  // the housing: close enough to supply the shops, far enough that the noise
  // does not land on anybody's home.
  for (let x = east.x; x <= east.x + east.w; x++) {
    for (let y = top + height - 4; y <= top + height; y++) {
      const tile = idx(x, y);
      if (world.adjacentRoad(tile) >= 0) world.paintZone(tile, Zone.Industrial);
    }
  }

  // Two plants on the eastern edge, where there is room and nobody lives. The
  // service road goes in first: a plant needs a road to feed the cable into.
  for (const y of [top + 2, top + height - 2]) {
    world.placeRoad(idx(east.x + east.w + 1, y));
    world.placePowerPlant(idx(east.x + east.w + 2, y));
  }

  seedPrimaryIndustry(world);
}

/**
 * Zone whatever primary industry the ground around the town supports, and put
 * a road to it.
 *
 * The deposits are generated from the map seed, so this cannot be hand-placed:
 * it looks for the nearest patch of each kind, runs a road out to it and zones
 * a few tiles. That leaves the player with one of each industry working and
 * the obvious next move -- expanding the one their land is actually good for.
 */
function seedPrimaryIndustry(world: World): void {
  const town = idx(92, 64);
  for (const [resource, zone] of [
    [Resource.Fertile, Zone.Farm],
    [Resource.Forest, Zone.Forestry],
    [Resource.Ore, Zone.Mining],
  ] as const) {
    const patch = nearestResource(world, town, resource);
    if (patch < 0) continue;

    // The spur has to start from a tile that is already road: a lane that
    // touches nothing is off the network, which means off the power grid and
    // out of reach of the factories -- the outpost would be dead on arrival.
    const from = nearestRoad(world, patch);
    if (from < 0) continue;

    const laid = connectByRoad(world, from, patch);
    // The river will not be bridged by a road tool that refuses to build on
    // water, so a spur can end up on the far bank with a gap in the middle.
    // An outpost the city cannot reach is worse than no outpost, so the spur
    // is taken back up rather than left as a stub.
    if (!findPath(world.roads, from, patch)) {
      for (const tile of laid) world.bulldoze(tile);
      continue;
    }

    // A service road across the patch, and the ground either side of it zoned:
    // enough to feed a couple of factories, and nowhere near enough to feed
    // the city this will grow into.
    const px = tileX(patch);
    const py = tileY(patch);
    for (let dx = -3; dx <= 3; dx++) world.placeRoad(world.map.at(px + dx, py));
    for (let dx = -3; dx <= 3; dx++) {
      for (const dy of [-1, 1]) {
        const tile = world.map.at(px + dx, py + dy);
        if (tile >= 0 && world.map.getResource(tile) === resource) world.paintZone(tile, zone);
      }
    }
  }
}

/** The road tile closest to `tile`, or -1 if the city has no roads at all. */
function nearestRoad(world: World, tile: TileIndex): TileIndex {
  let best = -1;
  let bestDistance = Infinity;
  for (let i = 0; i < world.map.road.length; i++) {
    if (!world.map.isRoad(i)) continue;
    const d = manhattan(tile, i);
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  }
  return best;
}

function nearestResource(world: World, from: TileIndex, resource: Resource): TileIndex {
  let best = -1;
  let bestDistance = Infinity;
  for (let tile = 0; tile < world.map.resource.length; tile++) {
    if (world.map.getResource(tile) !== resource) continue;
    const d = manhattan(from, tile);
    if (d < bestDistance) {
      bestDistance = d;
      best = tile;
    }
  }
  return best;
}

/** An L-shaped road between two tiles. Returns the tiles it actually laid. */
function connectByRoad(world: World, from: TileIndex, to: TileIndex): TileIndex[] {
  const laid: TileIndex[] = [];
  let x = tileX(from);
  let y = tileY(from);
  const tx = tileX(to);
  const ty = tileY(to);
  const step = (tile: TileIndex): void => {
    if (world.placeRoad(tile)) laid.push(tile);
  };
  while (x !== tx) {
    x += Math.sign(tx - x);
    step(idx(x, y));
  }
  while (y !== ty) {
    y += Math.sign(ty - y);
    step(idx(x, y));
  }
  return laid;
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
    overlay,
    hoverTile,
    selected: inspector.selected,
    pendingStations,
  });

  if (now > noticeUntil) notice = '';
  hud.update(sim, tool, overlay, pendingStations, notice);
  inspector.update(sim);
  statsPanel.update(sim, now);
  budgetPanel.update(sim, now);

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
