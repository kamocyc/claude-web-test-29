import type { ToolMode } from '../track/app/buildTool';
import { groupWarnings, nextPlace, type WarningGroup } from '../track/app/warnings';
import { InfoWindow } from '../ui/window';
import { button, note, row, section } from '../ui/widgets';
import { CityApp } from './app';
import { Hud, type PanelId } from './hud';
import { CIVIC_KINDS, coverage, REFUSAL_TEXT } from './civic';
import { isHome } from './buildings';
import { formatMoney } from '../ui/money';
import { clearSave, readSave } from './persistence';
import { DEFAULT_SPEED } from './simulation';

/**
 * The city, wired up.
 *
 * Input is the only thing here that is not in a module of its own, and it is
 * here on purpose: the pointer means different things in the two views (a ray
 * into the world, or a point on a map), and the keyboard has to reach the
 * tool, the camera and the views at once. Everything else -- the world, the
 * tool, the two renderers, the chrome -- is assembled, not implemented.
 */

const canvas3d = document.getElementById('view3d') as HTMLCanvasElement;
const canvas2d = document.getElementById('map') as HTMLCanvasElement;
const topbar = document.getElementById('topbar')!;
const toolbar = document.getElementById('toolbar')!;
const windowLayer = document.getElementById('windows')!;

// A saved city decides the ground, so it has to be found before the world is
// built rather than poured into one that has already generated other terrain.
const opening = readSave();
const app = new CityApp({ canvas3d, canvas2d, seed: opening?.seed, save: opening ?? undefined });

// ------------------------------------------------------------------ windows

const right = (width: number): number => Math.max(12, window.innerWidth - width - 12);
const windows: Record<PanelId, InfoWindow> = {
  warnings: new InfoWindow(windowLayer, 'warnings', '警告', { x: right(360), y: 12, width: 360 }),
  stats: new InfoWindow(windowLayer, 'stats', '統計', { x: 12, y: 12, width: 300 }),
  lines: new InfoWindow(windowLayer, 'lines', '路線', { x: right(340), y: 200, width: 340 }),
  help: new InfoWindow(windowLayer, 'help', '遊びかた', { x: 340, y: 60, width: 380 }),
};
windows.warnings.setHelp(
  '敷設した線形について engine が出した指摘です。行をクリックすると、その場所へ視点が移り、'
  + '輪で囲って示します。同じ内容が複数あれば、押すたびに次の場所へ進みます。',
);

buildHelp(windows.help.body);

const hud = new Hud(topbar, toolbar, {
  onSpeed: (index) => {
    app.sim.speed = index;
  },
  onMode: (mode) => setMode(mode),
  onClass: (id) => app.setClass(id),
  onZone: (zone) => {
    app.setZone(zone);
    setMode('zone');
  },
  onElevation: (steps) => app.tool.adjustElevation(steps),
  onView: (view) => app.setView(view),
  onPanel: (panel) => windows[panel].toggle(),
  onStationRotate: (steps) => app.tool.rotateStation(steps),
  onCivic: (type) => app.setCivic(type),
  onSave: () => saveNow(true),
  onLoad: () => loadNow(),
  onNew: () => startOver(),
});

/** A short message over the toolbar, for a refusal the player needs to see. */
let notice = '';
let noticeUntil = 0;
function say(message: string): void {
  notice = message;
  noticeUntil = performance.now() + 4000;
}

// -------------------------------------------------------------------- saving

/**
 * Set when the page is being reloaded on purpose (a new city, or opening a
 * save of different ground).
 *
 * Without it the autosave below fires as the page goes away and writes the
 * city being abandoned straight back over the one being opened -- which is
 * exactly what "new city" did the first time it was tried.
 */
let leaving = false;

function saveNow(announce = false): void {
  if (leaving) return;
  try {
    app.save();
    if (announce) say('保存しました');
  } catch {
    // A browser with storage turned off, or a save too big for the quota.
    // Losing the save is bad; losing the city that is running is worse.
    say('保存できませんでした');
  }
}

function loadNow(): void {
  const save = readSave();
  if (!save) {
    say('セーブがありません');
    return;
  }
  // A save of different ground cannot be opened in place -- the terrain is
  // generated once, when the world is built -- so start the page again and
  // let it open the save from the beginning.
  if (app.load(save)) say('読み込みました');
  else {
    leaving = true;
    location.reload();
  }
}

function startOver(): void {
  if (!window.confirm('この街を捨てて、新しい街を始めますか。')) return;
  clearSave();
  leaving = true;
  location.reload();
}

// Autosaved when the tab goes away, which is when a city is actually lost.
// Not on a timer: a save that happens while the player is mid-thought is a
// save they did not ask for.
window.addEventListener('pagehide', () => saveNow());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveNow();
});

function setMode(mode: ToolMode): void {
  app.setMode(mode);
}

windows.warnings.open();

// ------------------------------------------------------------------ pointer

let panning = false;
let lastX = 0;
let lastY = 0;

const rectOf = (): DOMRect =>
  (app.view === '3d' ? canvas3d : canvas2d).getBoundingClientRect();

function updateCursor(e: MouseEvent): void {
  const overMap = e.target === canvas3d || e.target === canvas2d;
  app.cursor = overMap ? app.pick(e.clientX, e.clientY, rectOf()) : null;
}

for (const canvas of [canvas3d, canvas2d]) {
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('mousedown', (e) => {
    lastX = e.clientX;
    lastY = e.clientY;
    if (e.button === 2 || e.button === 1) {
      panning = true;
      // A right click with nothing in hand cancels what the tool was drawing,
      // the same as Esc. Dragging pans instead, so the cancel happens on
      // mouseup only if the pointer never moved.
      return;
    }
    updateCursor(e);

    // A civic building in hand takes the click before the tool sees it.
    if (app.civicType !== null) {
      if (!app.cursor) return;
      const refusal = app.placeCivic(app.cursor);
      if (refusal) say(REFUSAL_TEXT[refusal]);
      return;
    }

    app.tool.update(app.cursor, app.modifiers);
    const status = app.tool.status();

    // The bulldozer takes down the city's own buildings too. Checked first,
    // because a hospital standing beside a road is nearer the pointer than
    // the road is, and the player is pointing at the hospital.
    if (status.mode === 'bulldoze' && app.cursor) {
      const civic = app.civicAt(app.cursor);
      if (civic) {
        app.removeCivic(civic);
        say('撤去しました');
        return;
      }
    }

    // The second click of a run is the one that spends the money, and the
    // status bar has already quoted the price -- so the refusal happens
    // where the player is looking.
    if (status.mode === 'build' && status.drawing && !app.sim.treasury.canAfford(status.cost)) {
      say('資金が足りません');
      return;
    }
    app.tool.click();
  });
}

window.addEventListener('mousemove', (e) => {
  if (panning) {
    if (app.view === 'plan') app.plan.panByPixels(e.clientX - lastX, e.clientY - lastY);
    lastX = e.clientX;
    lastY = e.clientY;
    return;
  }
  updateCursor(e);
});

window.addEventListener('mouseup', (e) => {
  if (panning && Math.hypot(e.clientX - lastX, e.clientY - lastY) < 3 && e.button === 2) {
    app.tool.cancel();
  }
  panning = false;
});

canvas2d.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const rect = rectOf();
    app.plan.zoomAt(
      e.clientX - rect.left,
      e.clientY - rect.top,
      e.deltaY < 0 ? 1.12 : 1 / 1.12,
    );
  },
  { passive: false },
);

// ----------------------------------------------------------------- keyboard

const MODE_KEYS: Record<string, ToolMode> = {
  b: 'build',
  t: 'station',
  z: 'zone',
  l: 'line',
  x: 'bulldoze',
  v: 'inspect',
};

window.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;

  const key = e.key.toLowerCase();
  if (key === 'shift') app.modifiers.straight = true;
  if (key === 'control') app.modifiers.noSnap = true;

  // Ctrl+S saves, as it does everywhere else. Taken from the browser, which
  // would otherwise offer to save the page itself.
  if (key === 's' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    saveNow(true);
    return;
  }
  if (e.ctrlKey || e.metaKey) return;

  if (key === 'tab') {
    e.preventDefault();
    app.setView(app.view === '3d' ? 'plan' : '3d');
    return;
  }
  if (key === 'escape') {
    app.civicType = null;
    app.tool.cancel();
    return;
  }
  if (MODE_KEYS[key]) {
    setMode(MODE_KEYS[key]);
    return;
  }
  if (key === 'n' || key === 'm') {
    app.tool.rotateStation(key === 'n' ? 1 : -1);
    return;
  }
  // 1-5 set the speed, as they did in the tile city.
  if (key >= '1' && key <= '5') {
    app.sim.speed = Number(key) - 1;
    return;
  }
  if (key === ' ') {
    e.preventDefault();
    app.sim.speed = app.sim.speed === 0 ? DEFAULT_SPEED : 0;
    return;
  }
  if (e.key === 'PageUp' || e.key === 'PageDown') {
    e.preventDefault();
    app.tool.adjustElevation(e.key === 'PageUp' ? 1 : -1);
  }
});

window.addEventListener('keyup', (e) => {
  const key = e.key.toLowerCase();
  if (key === 'shift') app.modifiers.straight = false;
  if (key === 'control') app.modifiers.noSnap = false;
});

// -------------------------------------------------------------------- panels

let warningGroups: WarningGroup[] = [];
let shownRevision = -1;
let lastPanelDraw = 0;

function refreshPanels(now: number): void {
  const stale = app.world.revision !== shownRevision;
  if (!stale && now - lastPanelDraw < 400) return;
  lastPanelDraw = now;
  shownRevision = app.world.revision;

  if (windows.warnings.isVisible) drawWarnings();
  if (windows.stats.isVisible) drawStats();
  if (windows.lines.isVisible) drawLines();
}

function drawWarnings(): void {
  const result = app.world.result;
  warningGroups = groupWarnings(result?.warnings ?? []);
  const body = windows.warnings.body;
  body.innerHTML = '';
  if (warningGroups.length === 0) {
    body.append(note('指摘はありません。'));
    return;
  }
  for (const group of warningGroups) {
    const line = row(
      group.severity === 'error' ? '⚠' : '・',
      `${group.message}${group.places.length > 1 ? `（${group.places.length}か所）` : ''}`,
      group.severity === 'error',
    );
    if (group.places.length > 0) {
      const go = button('見る', () => {
        const place = nextPlace(group);
        if (place) app.showPlace(place);
      });
      go.className = 'small';
      line.appendChild(go);
    }
    body.appendChild(line);
  }
}

function drawStats(): void {
  const stats = app.world.result?.stats;
  const body = windows.stats.body;
  body.innerHTML = '';
  if (!stats) return;
  body.append(
    section('ネットワーク', [
      row('総延長', `${(stats.totalLength / 1000).toFixed(2)} km`),
      row('区間', `${stats.segments}`),
      row('交差点', `${stats.intersections}`),
      row('分岐器', `${stats.turnouts}`),
      row('踏切', `${stats.levelCrossings}`),
      row('橋', `${(stats.bridgeLength / 1000).toFixed(2)} km`),
      row('トンネル', `${(stats.tunnelLength / 1000).toFixed(2)} km`),
    ]),
    section('街', [
      row('駅', `${stats.stations}`),
      row('路線', `${stats.lines}`),
      row('区画のマス', `${stats.zoneCells}`),
      row('建物', `${stats.buildings}`),
    ]),
    section('つながり', [
      row('道路網', `${stats.roadNetworks}`),
      row('鉄道網', `${stats.railNetworks}`),
      row('電力網', `${stats.powerNetworks}`),
    ]),
    civicSection(),
    section('財政', [
      row('所持金', formatMoney(app.sim.treasury.balance)),
      row('昨日の税収', formatMoney(app.sim.treasury.lastDay.income)),
      row('昨日の支出', formatMoney(app.sim.treasury.lastDay.expenses)),
      row('建設に使った額', formatMoney(app.sim.treasury.spent)),
    ]),
  );
}

/**
 * The civic buildings, with what each is doing for the people who live near
 * one -- the share of the city inside its catchment, which is the only
 * measure of a hospital that means anything.
 */
function civicSection(): HTMLElement {
  const homes = app.sim.buildings.filter((b) => b.alive && isHome(b));
  const rows: HTMLElement[] = [];
  for (const kind of CIVIC_KINDS) {
    const built = app.sim.buildings.filter((b) => b.alive && b.type === kind.type).length;
    if (built === 0) continue;
    const served = homes.length === 0
      ? 0
      : homes.reduce((n, b) => n + (coverage(app.sim.buildings, kind.type, b.at) > 0 ? 1 : 0), 0);
    rows.push(row(
      kind.label,
      `${built}　住宅の ${homes.length === 0 ? 0 : Math.round((served / homes.length) * 100)}%`,
    ));
  }
  if (rows.length === 0) {
    return section('公共施設', [note('まだ何も建てていません。下の「施設」から選んで置きます。')]);
  }
  return section('公共施設', rows);
}

function drawLines(): void {
  const body = windows.lines.body;
  body.innerHTML = '';
  const plans = app.world.builder.linePlans;
  if (plans.length === 0) {
    body.append(
      note('路線がありません。'),
      note('「路線」モードにして、停める駅のホームを順にクリックすると路線になります。'),
    );
    return;
  }
  const report = app.sim.lineReport();
  for (const plan of plans) {
    const line = app.world.lines.get(plan.id);
    const load = report.get(plan.id);
    body.appendChild(row(
      line?.name ?? `路線 ${plan.id}`,
      plan.runnable
        ? `列車 ${load?.trains ?? 0}　乗車 ${load?.riders ?? 0}　待ち ${load?.waiting ?? 0}`
        : '⚠ 線路が繋がっていません',
      !plan.runnable,
    ));
    body.appendChild(note(
      `${plan.stops.map((s) => s.name).join(' — ')}　${(plan.length / 1000).toFixed(2)} km`,
    ));
  }
}

function buildHelp(body: HTMLElement): void {
  body.append(
    section('視点', [
      note('右ドラッグで視点移動、ホイールで拡大縮小。Tab で 3D と平面を切り替えます。'),
    ]),
    section('敷設', [
      note('左クリックで始点、次のクリックで確定。続けて繋げられます。'
        + '右クリックか Esc で中断します。'),
      note('Shift で直線・15°スナップ、Ctrl でスナップを一時解除。'
        + 'PageUp / PageDown で敷設高さを 3m ずつ変え、高架・トンネルにします。'),
      note('既存の線形の端や途中を指すと、位置・接線・勾配を引き継いで接続します。'
        + '線路では曲率も引き継ぎ、分岐は接線に沿ったものだけを置きます。'),
    ]),
    section('公共施設', [
      note('下の「施設」から選び、道路の近くの空き地をクリックすると建ちます。'
        + '効果はその施設の範囲に届く住宅にだけ及びます (平面表示で範囲が見えます)。'),
      note('公共施設は毎日の維持費がかかります。撤去は「撤去」モードでクリックします。'),
    ]),
    section('タイル版', [
      note('この街の元になったタイル版は classic.html にあります。'
        + '格子のマップで、道路も線路も 1 マス単位です。'),
    ]),
    section('街', [
      note('「保存」でこのブラウザに街を保存します (Ctrl+S)。'
        + 'タブを閉じるときにも自動で保存します。'),
      note('「読込」で保存した街に戻り、「新規」で保存を捨てて新しい街を始めます。'),
    ]),
    section('モード', [
      note('B 敷設 / T 駅 / Z 区画 / L 路線 / X 撤去 / V 確認。'),
      note('区画は道路沿いのマスに用途を塗ります。塗ったマスがまとまって敷地になり、'
        + '建物が建ちます。道路を撤去すればその沿道の建物も無くなります。'),
    ]),
  );
}

// --------------------------------------------------------------------- frame

function resize(): void {
  app.resize();
  for (const id of Object.keys(windows) as PanelId[]) windows[id].clampIntoView();
}
window.addEventListener('resize', resize);
resize();
app.setView('3d');

function frame(now: number): void {
  app.frame(now);
  const status = app.tool.status();
  const worst = app.world.result?.warnings.find((w) => w.severity === 'error');
  hud.update(
    status,
    app.world.result?.stats ?? null,
    app.sim.stats,
    app.sim.treasury,
    app.sim.format(),
    app.sim.speed,
    app.view,
    notice || worst?.message || '',
    app.civicType,
  );
  if (now > noticeUntil) notice = '';
  refreshPanels(now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Handy for poking at the city from the console, and for the smoke test.
declare global {
  interface Window {
    city: CityApp;
  }
}
window.city = app;
