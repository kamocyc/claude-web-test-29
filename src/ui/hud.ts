import { SPEED_MULTIPLIERS } from '../config';
import { cityWarnings } from '../sim/diagnostics';
import type { Simulation } from '../sim/simulation';
import { expenseOf, lineToolFor, Tool, TOOL_LABELS, type ToolGroup } from './tools';
import { LineMode } from '../world/transit';
import { formatMoney } from './money';
import { iconMarkup, type IconName } from './icons';
import type { Overlay } from '../render/renderer';

/** The information windows the toolbar can open, in the order they appear. */
export type PanelId =
  | 'inspector'
  | 'warnings'
  | 'power'
  | 'budget'
  | 'stats'
  | 'services'
  | 'help';

export interface HudCallbacks {
  onTool(tool: Tool): void;
  onSpeed(index: number): void;
  onToggleZones(): void;
  onToggleIssues(): void;
  onOverlay(overlay: Overlay): void;
  onPickRandom(): void;
  onCommitLine(): void;
  onCancelLine(): void;
  onSave(): void;
  onLoad(): void;
  onPanel(panel: PanelId): void;
}

export interface HudState {
  tool: Tool;
  overlay: Overlay;
  showZones: boolean;
  showIssues: boolean;
  pendingStations: readonly number[];
  notice: string;
  /** Which information windows are open, so their buttons can light up. */
  openPanels: ReadonlySet<PanelId>;
}

/**
 * The game's chrome, laid out the way Cities: Skylines lays its own out: the
 * city's vital signs across the top, the things you can build along the
 * bottom, and the map in between with nothing on it.
 *
 * The bottom bar is **one row of icons in labelled groups** -- 選択 / 道路 /
 * 鉄道 / バス / 区画 / 公共 / 撤去 / ビュー / ウィンドウ / システム. It used to be
 * two rows of wrapping text buttons, which meant the buttons moved whenever the
 * window was resized: a player who had learnt where 撤去 was found it somewhere
 * else on a narrower screen, and the bar ate a fifth of the map. Icons in a
 * fixed order cost a third of the width, never reflow, and put related actions
 * next to each other rather than in whatever order they happened to be written.
 *
 * Nothing here explains itself in prose: the strip above the row names
 * whatever the pointer is on (and, when it is on nothing, the tool currently
 * in hand), and the longer answers live behind the "？" in each window's title
 * bar and in 遊びかた.
 */
export class Hud {
  private readonly clockEl: HTMLElement;
  private readonly moneyEl: HTMLElement;
  private readonly statChips = new Map<string, HTMLElement>();
  private readonly warningEl: HTMLElement;
  private readonly warningCountEl: HTMLElement;
  private readonly lineBar: HTMLElement;
  private readonly lineStatus: HTMLElement;
  private readonly loadButton: HTMLButtonElement;
  private readonly toolButtons = new Map<Tool, HTMLButtonElement>();
  private readonly speedButtons: HTMLButtonElement[] = [];
  private readonly overlayButtons = new Map<Overlay, HTMLButtonElement>();
  private readonly panelButtons = new Map<PanelId, HTMLButtonElement>();
  private readonly zoneButton: HTMLButtonElement;
  private readonly issueButton: HTMLButtonElement;
  /** Names whatever the pointer is on, or the tool in hand. */
  private readonly captionEl: HTMLElement;
  private hovered = '';

  constructor(
    top: HTMLElement,
    bottom: HTMLElement,
    private readonly cb: HudCallbacks,
  ) {
    top.innerHTML = '';
    bottom.innerHTML = '';

    // --- Top bar: the city's vital signs -----------------------------------

    this.clockEl = el('div', 'hud-clock');
    this.moneyEl = el('div', 'hud-money');

    const chips = el('div', 'hud-chips');
    for (const [key, label] of CHIPS) {
      const chip = el('div', 'chip');
      const name = el('span', 'chip-label');
      name.textContent = label;
      const value = el('span', 'chip-value');
      chip.append(name, value);
      chips.appendChild(chip);
      this.statChips.set(key, value);
    }

    const speeds = el('div', 'hud-group hud-speeds');
    SPEED_MULTIPLIERS.forEach((m, i) => {
      const b = document.createElement('button');
      if (m === 0) b.innerHTML = iconMarkup('pause');
      else b.textContent = `×${m}`;
      b.className = 'speed-button';
      label(b, m === 0 ? '一時停止 (Space)' : m === 0.25 ? '観察速度: 市民1人を追える' : `×${m}`);
      b.addEventListener('click', () => this.cb.onSpeed(i));
      speeds.appendChild(b);
      this.speedButtons.push(b);
    });

    this.warningEl = el('div', 'hud-warning');
    this.warningCountEl = el('span', 'hud-warning-count');
    const warningButton = document.createElement('button');
    warningButton.className = 'hud-warning-button';
    label(warningButton, '警告の一覧を開く');
    warningButton.append(this.warningCountEl, this.warningEl);
    warningButton.addEventListener('click', () => this.cb.onPanel('warnings'));

    top.append(this.clockEl, this.moneyEl, chips, warningButton, speeds);

    // --- Bottom bar: one row, grouped ---------------------------------------

    this.captionEl = el('div', 'toolbar-caption');
    const row = el('div', 'toolbar-row');
    const groups = new Map<ToolGroup, HTMLElement>();
    for (const [id, label] of TOOL_GROUP_LABELS) {
      const g = group(label);
      groups.set(id, g.body);
      row.appendChild(g.root);
    }

    for (const info of TOOL_LABELS) {
      const expense = expenseOf(info.tool);
      const b = iconButton(info.icon, [
        info.label,
        info.key ? `(${info.key.toUpperCase()})` : '',
        expense ? COST_HINTS[expense] ?? '' : '',
      ], () => this.cb.onTool(info.tool));
      if (info.swatch) {
        b.classList.add('zone-button');
        b.style.setProperty('--swatch', info.swatch);
      }
      groups.get(info.group)?.appendChild(b);
      this.toolButtons.set(info.tool, b);
    }

    const views = group('ビュー');
    this.zoneButton = iconButton('viewZones', ['区画表示', '(Z)'], () => this.cb.onToggleZones());
    this.issueButton = iconButton('viewIssues', ['警告アイコン'], () => this.cb.onToggleIssues());
    views.body.append(this.zoneButton, this.issueButton);
    for (const [overlay, label, icon, key] of OVERLAYS) {
      const b = iconButton(icon, [label, `(${key})`], () => this.cb.onOverlay(overlay));
      views.body.appendChild(b);
      this.overlayButtons.set(overlay, b);
    }

    const panels = group('ウィンドウ');
    for (const [id, label, icon] of PANELS) {
      const b = iconButton(icon, [label], () => this.cb.onPanel(id));
      panels.body.appendChild(b);
      this.panelButtons.set(id, b);
    }
    panels.body.appendChild(
      iconButton('randomCitizen', ['市民をランダムに見る'], () => this.cb.onPickRandom()),
    );

    const system = group('システム');
    system.body.appendChild(iconButton('save', ['この街を保存'], () => this.cb.onSave()));
    this.loadButton = iconButton('load', ['保存した街を読み込む'], () => this.cb.onLoad());
    const helpButton = iconButton('help', ['遊びかた・ショートカット'], () => this.cb.onPanel('help'));
    this.panelButtons.set('help', helpButton);
    system.body.append(this.loadButton, helpButton);

    row.append(views.root, panels.root, system.root);

    // Second row, shown only while the line tool is picking stations.
    this.lineBar = el('div', 'hud-linebar');
    this.lineStatus = el('span', 'hud-linestatus');
    const commit = document.createElement('button');
    commit.textContent = 'この順で開業する';
    commit.addEventListener('click', () => this.cb.onCommitLine());
    const cancel = document.createElement('button');
    cancel.textContent = '取消';
    cancel.addEventListener('click', () => this.cb.onCancelLine());
    this.lineBar.append(this.lineStatus, commit, cancel);
    this.lineBar.hidden = true;

    bottom.append(this.lineBar, this.captionEl, row);

    // One caption for the whole bar, rather than a tooltip per button: the
    // name always appears in the same place, and it cannot be clipped by the
    // row when the bar is too narrow to fit and starts to scroll.
    row.addEventListener('mouseover', (e) => {
      const button = (e.target as HTMLElement).closest('button');
      this.hovered = button?.dataset.label ?? '';
    });
    row.addEventListener('mouseleave', () => {
      this.hovered = '';
    });

    // Most mice only have a vertical wheel, so on a window too narrow for the
    // whole bar the wheel scrolls it sideways -- otherwise reaching 撤去 would
    // mean dragging a 4px scrollbar, which is worse than the wrapping row this
    // replaced.
    row.addEventListener('wheel', (e) => {
      if (row.scrollWidth <= row.clientWidth) return;
      e.preventDefault();
      row.scrollLeft += e.deltaY + e.deltaX;
    }, { passive: false });
  }

  /** Greyed out until there is something to load, so the button never lies. */
  setSaveAvailable(available: boolean): void {
    this.loadButton.disabled = !available;
  }

  update(sim: Simulation, state: HudState): void {
    this.clockEl.textContent = sim.clock.format();

    const net = sim.economy.lastDay.net;
    this.moneyEl.textContent = `${formatMoney(sim.economy.balance)}　(${net >= 0 ? '+' : ''}${formatMoney(net)}/日)`;
    this.moneyEl.classList.toggle('negative', sim.economy.balance < 0);

    const world = sim.world;
    const power = sim.power.report;
    this.setChip('population', `${world.population}`);
    this.setChip('jobs', `${world.employedCount}/${world.jobCount}`);
    this.setChip('happiness', `${Math.round(sim.happiness.breakdown.overall)}`);
    this.setChip(
      'power',
      power.shortfall > 0
        ? `${Math.round(power.supply)}/${Math.round(power.demand)}　不足${Math.round(power.shortfall)}`
        : `${Math.round(power.supply)}/${Math.round(power.demand)}`,
    );
    this.chipWarn('power', power.shortfall > 0);
    const rail = world.activeLines.filter((l) => l.mode === LineMode.Rail).length;
    const bus = world.activeLines.length - rail;
    this.setChip('transit', `${rail}路線 バス${bus}系統　待ち${sim.stats.live.waiting}`);

    const warnings = cityWarnings(sim);
    const worst = warnings[0];
    this.warningEl.textContent = state.notice || (worst ? `${worst.icon} ${worst.title}` : '順調です');
    this.warningCountEl.textContent = warnings.length > 0 ? `${warnings.length}` : '';
    this.warningCountEl.hidden = warnings.length === 0;
    this.warningEl.className = 'hud-warning'
      + (state.notice ? ' notice' : worst ? ` ${worst.severity}` : '');

    const picking = lineToolFor(state.tool);
    this.lineBar.hidden = picking === null;
    if (picking !== null) {
      const what = picking === LineMode.Rail ? '駅' : 'バス停';
      this.lineStatus.textContent = state.pendingStations.length === 0
        ? `${what}を順にクリックしてください（2つ以上）`
        : `選択中: ${state.pendingStations.length} ${what}`;
    }

    for (const [t, b] of this.toolButtons) b.classList.toggle('active', t === state.tool);
    for (const [o, b] of this.overlayButtons) b.classList.toggle('active', o === state.overlay);
    for (const [id, b] of this.panelButtons) b.classList.toggle('active', state.openPanels.has(id));
    this.zoneButton.classList.toggle('active', state.showZones);
    this.issueButton.classList.toggle('active', state.showIssues);
    this.speedButtons.forEach((b, i) => b.classList.toggle('active', i === sim.clock.speedIndex));

    const inHand = TOOL_LABELS.find((t) => t.tool === state.tool);
    this.captionEl.textContent = this.hovered || (inHand ? `${inHand.label} を選択中` : '');
  }

  private setChip(key: string, value: string): void {
    const el = this.statChips.get(key);
    if (el) el.textContent = value;
  }

  private chipWarn(key: string, warn: boolean): void {
    this.statChips.get(key)?.classList.toggle('warn', warn);
  }
}

/** The always-visible readouts along the top, in reading order. */
const CHIPS: ReadonlyArray<[string, string]> = [
  ['population', '人口'],
  ['jobs', '雇用'],
  ['happiness', '幸福度'],
  ['power', '電力'],
  ['transit', '公共交通'],
];

/** The building half of the toolbar, in the order the groups appear. */
const TOOL_GROUP_LABELS: ReadonlyArray<[ToolGroup, string]> = [
  ['select', '選択'],
  ['road', '道路'],
  ['rail', '鉄道'],
  ['bus', 'バス'],
  ['zone', '区画'],
  ['civic', '公共'],
  ['bulldoze', '撤去'],
];

const PANELS: ReadonlyArray<[PanelId, string, IconName]> = [
  ['inspector', '詳細', 'winInspector'],
  ['warnings', '警告', 'winWarnings'],
  ['power', '電力', 'winPower'],
  ['budget', '財政', 'winBudget'],
  ['stats', '統計', 'winStats'],
  ['services', '公共', 'winServices'],
];

const OVERLAYS: ReadonlyArray<[Overlay, string, IconName, string]> = [
  ['traffic', '渋滞', 'overlayTraffic', 'T'],
  ['power', '電力', 'overlayPower', 'P'],
  ['noise', '騒音', 'overlayNoise', 'N'],
  ['landValue', '地価', 'overlayLandValue', 'V'],
  ['crime', '治安', 'overlayCrime', 'C'],
  ['services', '公共カバー', 'overlayServices', 'B'],
  ['height', '標高', 'overlayHeight', 'M'],
];

const COST_HINTS: Partial<Record<string, string>> = {
  road: '¥45/タイル',
  rail: '¥120/タイル',
  zone: '¥25/タイル',
  station: '¥4,000',
  elevatedRoad: '¥700/タイル',
  elevatedRail: '¥1,500/タイル',
  busStop: '¥900',
  powerPlant: '¥22,000',
  school: '¥30,000',
  fireStation: '¥26,000',
  policeStation: '¥24,000',
  bulldoze: '¥15',
};

function el(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}

/** An icon button, named for the caption strip and for screen readers. */
function iconButton(
  name: IconName,
  parts: readonly string[],
  onClick: () => void,
): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'tool-button';
  b.innerHTML = iconMarkup(name);
  label(b, parts.filter((part) => part !== '').join('　'));
  b.addEventListener('click', onClick);
  return b;
}

/**
 * The name of a control, in the one place that carries it.
 *
 * An icon with no name is a guessing game, so the same string is what the
 * caption strip shows, what the browser's own tooltip says for anyone who
 * waits for one, and what a screen reader announces.
 */
function label(b: HTMLElement, text: string): void {
  b.dataset.label = text;
  b.title = text;
  b.setAttribute('aria-label', text);
}

/** A labelled cluster of buttons in the single toolbar row. */
function group(name: string): { root: HTMLElement; body: HTMLElement } {
  const root = el('div', 'tool-group');
  const caption = el('span', 'tool-group-label');
  caption.textContent = name;
  const body = el('div', 'tool-group-body');
  root.append(caption, body);
  return { root, body };
}
