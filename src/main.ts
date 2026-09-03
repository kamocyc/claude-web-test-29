import { tileX, tileY } from './core/grid';
import {
  BuildingType,
  isAtRest,
  type BuildingId,
  type TileIndex,
} from './core/types';
import { Camera } from './render/camera';
import { Renderer } from './render/renderer';
import type { Citizen } from './sim/citizen';
import type { Lorry } from './sim/lorry';
import { Simulation } from './sim/simulation';
import { attachInput } from './ui/input';
import { Hud, type PanelId } from './ui/hud';
import { Inspector, INSPECTOR_HELP } from './ui/inspector';
import { StatsPanel, STATS_HELP } from './ui/stats';
import { PowerPanel, POWER_HELP } from './ui/power';
import { WarningsPanel, WARNINGS_HELP } from './ui/warnings';
import { HelpPanel } from './ui/help';
import { InfoWindow } from './ui/window';
import { applyTool, isDragTool, Tool, TOOL_BY_KEY } from './ui/tools';
import { BudgetPanel, BUDGET_HELP } from './ui/budget';
import type { Overlay } from './render/renderer';
import { createLineThrough } from './world/lineBuilder';
import { hasSavedCity, loadFromStorage, saveToStorage } from './world/persistence';
import { newGame, STARTING_VIEW } from './world/scenario';

const canvas = document.getElementById('map') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const topbarRoot = document.getElementById('topbar')!;
const toolbarRoot = document.getElementById('toolbar')!;
const windowLayer = document.getElementById('windows')!;

/**
 * The information windows, laid out so that the two a new player needs -- what
 * they clicked on, and what is wrong with the city -- start open on opposite
 * sides, and the rest are a button away.
 */
const right = (width: number): number => Math.max(12, window.innerWidth - width - 12);
const windows: Record<PanelId, InfoWindow> = {
  inspector: new InfoWindow(windowLayer, 'inspector', '詳細', { x: 12, y: 12, width: 320 }),
  warnings: new InfoWindow(windowLayer, 'warnings', '警告', {
    x: right(340), y: 12, width: 340,
  }),
  power: new InfoWindow(windowLayer, 'power', '電力', { x: 350, y: 40, width: 300 }),
  budget: new InfoWindow(windowLayer, 'budget', '財政', { x: 670, y: 70, width: 300 }),
  stats: new InfoWindow(windowLayer, 'stats', '統計', { x: right(700), y: 100, width: 320 }),
  help: new InfoWindow(windowLayer, 'help', '遊びかた', { x: 380, y: 90, width: 360 }),
};

/**
 * The standing explanations, behind each window's "？" rather than printed
 * next to the numbers they are about.
 */
windows.inspector.setHelp(INSPECTOR_HELP);
windows.warnings.setHelp(WARNINGS_HELP);
windows.power.setHelp(POWER_HELP);
windows.budget.setHelp(BUDGET_HELP);
windows.stats.setHelp(STATS_HELP);

/**
 * The simulation is a `let` rather than a `const` because loading a save
 * replaces it wholesale. Rebuilding is what makes a load safe: every id in the
 * sim is an array index, so patching a live city in place would leave the
 * panels pointing at citizens that no longer exist.
 */
let sim = new Simulation(newGame());
const camera = new Camera();
const renderer = new Renderer(ctx, camera);
const inspector = new Inspector(windows.inspector.body);
const statsPanel = new StatsPanel(windows.stats.body);
const powerPanel = new PowerPanel(windows.power.body);
new HelpPanel(windows.help.body);
const warningsPanel = new WarningsPanel(windows.warnings.body, {
  onShowMe: (tile) => showTile(tile),
});
const budgetPanel = new BudgetPanel(windows.budget.body, {
  onRate: (category, delta) => sim.economy.setRate(category, sim.economy.rates[category] + delta),
  onBorrow: () => say(sim.economy.borrow() ? '借入しました' : 'これ以上は借りられません'),
  onRepay: () => say(sim.economy.repay() ? '返済しました' : '返済できる残高がありません'),
});

let tool: Tool = Tool.Road;
let showZones = true;
/** Warning badges over failing buildings. On by default: they are the point. */
let showIssues = true;
let overlay: Overlay = 'none';
let hoverTile: TileIndex = -1;

/** A tile the warnings panel asked to be shown, ringed until it is stale. */
let focusTile: TileIndex = -1;
let focusUntil = 0;

/** Stations picked so far with the line tool, in order. */
let pendingStations: BuildingId[] = [];
let notice = '';
let noticeUntil = 0;

function say(message: string): void {
  notice = message;
  noticeUntil = performance.now() + 4000;
}

const hud = new Hud(topbarRoot, toolbarRoot, {
  onTool: (t) => {
    tool = t;
    if (t !== Tool.Line) pendingStations = [];
  },
  onSpeed: (i) => sim.clock.setSpeedIndex(i),
  onToggleZones: () => (showZones = !showZones),
  onToggleIssues: () => (showIssues = !showIssues),
  onOverlay: (o) => (overlay = overlay === o ? 'none' : o),
  onPickRandom: pickRandomCitizen,
  onCommitLine: commitLine,
  onCancelLine: () => {
    pendingStations = [];
  },
  onSave: saveCity,
  onLoad: loadCity,
  onPanel: (panel) => windows[panel].toggle(),
});
hud.setSaveAvailable(hasSavedCity());
windows.inspector.open();
windows.warnings.open();

/** Take the camera to a tile and ring it, so "見る" actually shows something. */
function showTile(tile: TileIndex): void {
  if (tile < 0) return;
  camera.centerOn(tileX(tile) + 0.5, tileY(tile) + 0.5);
  focusTile = tile;
  focusUntil = performance.now() + 6000;
}

camera.centerOn(STARTING_VIEW.x, STARTING_VIEW.y);

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

function openWindows(): Set<PanelId> {
  const open = new Set<PanelId>();
  for (const id of Object.keys(windows) as PanelId[]) {
    if (windows[id].isOpen) open.add(id);
  }
  return open;
}

function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  camera.resize(w, h);
  for (const id of Object.keys(windows) as PanelId[]) windows[id].clampIntoView();
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
    windows.inspector.open();
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
  if (bestLorry || bestCitizen) windows.inspector.open();
}

function pickRandomCitizen(): void {
  const travelling = sim.world.citizens.filter(
    (c) => !isAtRest(c.state),
  );
  const pool = travelling.length > 0 ? travelling : sim.world.citizens;
  if (pool.length === 0) return;
  const c = pool[Math.floor(Math.random() * pool.length)];
  inspector.select(c);
  windows.inspector.open();
  camera.centerOn(c.x, c.y);
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

  if (now > focusUntil) focusTile = -1;

  renderer.draw(sim, sim.clock.alpha, {
    showZones,
    showIssues,
    overlay,
    hoverTile,
    focusTile,
    selected: inspector.selected,
    pendingStations,
  });

  if (now > noticeUntil) notice = '';
  hud.update(sim, {
    tool,
    overlay,
    showZones,
    showIssues,
    pendingStations,
    notice,
    openPanels: openWindows(),
  });

  // Only the windows the player can actually see are worth rebuilding: a
  // closed panel that keeps formatting numbers is pure work per frame.
  if (windows.inspector.isVisible) {
    inspector.update(sim);
    windows.inspector.setTitle(inspector.title);
  }
  if (windows.stats.isVisible) statsPanel.update(sim, now);
  if (windows.budget.isVisible) budgetPanel.update(sim, now);
  if (windows.power.isVisible) powerPanel.update(sim, now);
  if (windows.warnings.isVisible) warningsPanel.update(sim, now);

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
