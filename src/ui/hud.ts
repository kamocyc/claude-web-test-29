import { SPEED_MULTIPLIERS } from '../config';
import { cityWarnings } from '../sim/diagnostics';
import type { Simulation } from '../sim/simulation';
import { expenseOf, Tool, TOOL_LABELS } from './tools';
import { formatMoney } from './money';
import type { Overlay } from '../render/renderer';

/** The information windows the toolbar can open, in the order they appear. */
export type PanelId = 'inspector' | 'warnings' | 'power' | 'budget' | 'stats';

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
 * The old single bar mixed all of it together -- clock, money, tools, zones,
 * overlays, saves and the current complaint in one wrapping row -- so nothing
 * had a fixed place and the eye had to search for the number it wanted every
 * time. Splitting it in two costs nothing and means the money is always in the
 * same corner.
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
      b.textContent = m === 0 ? '⏸' : `×${m}`;
      b.title = m === 0.25 ? '観察速度: 市民1人をゆっくり追える' : '';
      b.addEventListener('click', () => this.cb.onSpeed(i));
      speeds.appendChild(b);
      this.speedButtons.push(b);
    });

    this.warningEl = el('div', 'hud-warning');
    this.warningCountEl = el('span', 'hud-warning-count');
    const warningButton = document.createElement('button');
    warningButton.className = 'hud-warning-button';
    warningButton.title = '警告の一覧を開く';
    warningButton.append(this.warningCountEl, this.warningEl);
    warningButton.addEventListener('click', () => this.cb.onPanel('warnings'));

    top.append(this.clockEl, this.moneyEl, chips, warningButton, speeds);

    // --- Bottom bar: what the player can do --------------------------------

    const build = group('つくる');
    const zones = group('区画');
    for (const info of TOOL_LABELS) {
      const b = document.createElement('button');
      b.textContent = info.key ? `${info.label} (${info.key.toUpperCase()})` : info.label;
      const expense = expenseOf(info.tool);
      if (expense) b.title = `${info.label}: ${COST_HINTS[expense] ?? ''}`;
      if (info.group === 'zone') b.style.setProperty('--swatch', ZONE_SWATCHES[info.tool] ?? '');
      b.classList.add(info.group === 'zone' ? 'zone-button' : 'build-button');
      b.addEventListener('click', () => this.cb.onTool(info.tool));
      (info.group === 'zone' ? zones : build).body.appendChild(b);
      this.toolButtons.set(info.tool, b);
    }

    const views = group('情報ビュー');
    this.zoneButton = button('区画表示 (Z)', () => this.cb.onToggleZones());
    this.issueButton = button('警告アイコン', () => this.cb.onToggleIssues());
    views.body.append(this.zoneButton, this.issueButton);
    for (const [overlay, label] of OVERLAY_LABELS) {
      const b = button(label, () => this.cb.onOverlay(overlay));
      views.body.appendChild(b);
      this.overlayButtons.set(overlay, b);
    }

    const panels = group('ウィンドウ');
    for (const [id, label] of PANEL_LABELS) {
      const b = button(label, () => this.cb.onPanel(id));
      panels.body.appendChild(b);
      this.panelButtons.set(id, b);
    }
    panels.body.appendChild(button('市民をランダムに見る', () => this.cb.onPickRandom()));

    const saves = group('街');
    saves.body.appendChild(button('保存', () => this.cb.onSave()));
    this.loadButton = button('読み込み', () => this.cb.onLoad());
    saves.body.appendChild(this.loadButton);

    // Second row, shown only while the line tool is picking stations.
    this.lineBar = el('div', 'hud-linebar');
    this.lineStatus = el('span', 'hud-linestatus');
    this.lineBar.append(
      this.lineStatus,
      button('この順で路線を作る', () => this.cb.onCommitLine()),
      button('取消', () => this.cb.onCancelLine()),
    );
    this.lineBar.hidden = true;

    const groups = el('div', 'toolbar-groups');
    groups.append(build.root, zones.root, views.root, panels.root, saves.root);
    bottom.append(this.lineBar, groups);
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
    this.setChip('transit', `${world.activeLines.length}路線　待ち${sim.stats.live.waiting}`);

    const warnings = cityWarnings(sim);
    const worst = warnings[0];
    this.warningEl.textContent = state.notice || (worst ? `${worst.icon} ${worst.title}` : '順調です');
    this.warningCountEl.textContent = warnings.length > 0 ? `${warnings.length}` : '';
    this.warningCountEl.hidden = warnings.length === 0;
    this.warningEl.className = 'hud-warning'
      + (state.notice ? ' notice' : worst ? ` ${worst.severity}` : '');

    this.lineBar.hidden = state.tool !== Tool.Line;
    if (state.tool === Tool.Line) {
      this.lineStatus.textContent = state.pendingStations.length === 0
        ? '駅を順にクリックしてください（2駅以上）'
        : `選択中: ${state.pendingStations.length} 駅`;
    }

    for (const [t, b] of this.toolButtons) b.classList.toggle('active', t === state.tool);
    for (const [o, b] of this.overlayButtons) b.classList.toggle('active', o === state.overlay);
    for (const [id, b] of this.panelButtons) b.classList.toggle('active', state.openPanels.has(id));
    this.zoneButton.classList.toggle('active', state.showZones);
    this.issueButton.classList.toggle('active', state.showIssues);
    this.speedButtons.forEach((b, i) => b.classList.toggle('active', i === sim.clock.speedIndex));
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
  ['transit', '鉄道'],
];

const PANEL_LABELS: ReadonlyArray<[PanelId, string]> = [
  ['inspector', '詳細'],
  ['warnings', '警告'],
  ['power', '電力'],
  ['budget', '財政'],
  ['stats', '統計'],
];

const OVERLAY_LABELS: ReadonlyArray<[Overlay, string]> = [
  ['traffic', '渋滞 (T)'],
  ['power', '電力 (P)'],
  ['noise', '騒音 (N)'],
  ['landValue', '地価 (V)'],
];

/**
 * The colour chip on each zoning button, so the button and the ground it
 * paints are recognisably the same thing -- the way the zoning bar works in
 * Cities: Skylines.
 */
const ZONE_SWATCHES: Partial<Record<Tool, string>> = {
  [Tool.ResidentialLow]: '#8ed64a',
  [Tool.ResidentialHigh]: '#4f9e35',
  [Tool.Commercial]: '#4fa3e3',
  [Tool.Industrial]: '#e0c33c',
  [Tool.Office]: '#2fc4c4',
  [Tool.Farm]: '#cbb04a',
  [Tool.Forestry]: '#3f9a5a',
  [Tool.Fishery]: '#46b8cf',
  [Tool.Mining]: '#a97c52',
};

const COST_HINTS: Partial<Record<string, string>> = {
  road: '¥45/タイル',
  rail: '¥120/タイル',
  zone: '¥25/タイル',
  station: '¥4,000',
  powerPlant: '¥22,000',
  bulldoze: '¥15',
};

function el(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

/** A labelled cluster of buttons in the bottom toolbar. */
function group(label: string): { root: HTMLElement; body: HTMLElement } {
  const root = el('div', 'tool-group');
  const caption = el('span', 'tool-group-label');
  caption.textContent = label;
  const body = el('div', 'tool-group-body');
  root.append(body, caption);
  return { root, body };
}
