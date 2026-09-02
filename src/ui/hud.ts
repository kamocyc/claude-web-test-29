import { SPEED_MULTIPLIERS } from '../config';
import type { Simulation } from '../sim/simulation';
import { expenseOf, Tool, TOOL_LABELS } from './tools';
import { formatMoney } from './money';
import type { Overlay } from '../render/renderer';

export interface HudCallbacks {
  onTool(tool: Tool): void;
  onSpeed(index: number): void;
  onToggleZones(): void;
  onOverlay(overlay: Overlay): void;
  onPickRandom(): void;
  onCommitLine(): void;
  onCancelLine(): void;
  onSave(): void;
  onLoad(): void;
}

export class Hud {
  private readonly clockEl: HTMLElement;
  private readonly moneyEl: HTMLElement;
  private readonly statsEl: HTMLElement;
  private readonly warningEl: HTMLElement;
  private readonly lineBar: HTMLElement;
  private readonly lineStatus: HTMLElement;
  private readonly loadButton: HTMLButtonElement;
  private readonly toolButtons = new Map<Tool, HTMLButtonElement>();
  private readonly speedButtons: HTMLButtonElement[] = [];
  private readonly overlayButtons = new Map<Overlay, HTMLButtonElement>();

  constructor(root: HTMLElement, private readonly cb: HudCallbacks) {
    root.innerHTML = '';

    this.clockEl = el('div', 'hud-clock');
    this.moneyEl = el('div', 'hud-money');
    this.statsEl = el('div', 'hud-stats');
    this.warningEl = el('div', 'hud-warning');

    const tools = el('div', 'hud-group');
    const zones = el('div', 'hud-group');
    for (const info of TOOL_LABELS) {
      const b = document.createElement('button');
      b.textContent = info.key ? `${info.label} (${info.key.toUpperCase()})` : info.label;
      const expense = expenseOf(info.tool);
      if (expense) b.title = `${info.label}: ${COST_HINTS[expense] ?? ''}`;
      b.addEventListener('click', () => this.cb.onTool(info.tool));
      (info.group === 'zone' ? zones : tools).appendChild(b);
      this.toolButtons.set(info.tool, b);
    }

    const speeds = el('div', 'hud-group');
    SPEED_MULTIPLIERS.forEach((m, i) => {
      const b = document.createElement('button');
      b.textContent = m === 0 ? '⏸' : `×${m}`;
      b.title = m === 0.25 ? '観察速度: 市民1人をゆっくり追える' : '';
      b.addEventListener('click', () => this.cb.onSpeed(i));
      speeds.appendChild(b);
      this.speedButtons.push(b);
    });

    const overlays = el('div', 'hud-group');
    overlays.appendChild(button('ゾーン (Z)', () => this.cb.onToggleZones()));
    for (const [overlay, label] of OVERLAY_LABELS) {
      const b = button(label, () => this.cb.onOverlay(overlay));
      overlays.appendChild(b);
      this.overlayButtons.set(overlay, b);
    }
    overlays.appendChild(button('市民をランダムに見る', () => this.cb.onPickRandom()));

    const saves = el('div', 'hud-group');
    saves.appendChild(button('保存', () => this.cb.onSave()));
    this.loadButton = button('読み込み', () => this.cb.onLoad());
    saves.appendChild(this.loadButton);

    // Second row, shown only while the line tool is picking stations.
    this.lineBar = el('div', 'hud-linebar');
    this.lineStatus = el('span', 'hud-linestatus');
    this.lineBar.append(
      this.lineStatus,
      button('この順で路線を作る', () => this.cb.onCommitLine()),
      button('取消', () => this.cb.onCancelLine()),
    );
    this.lineBar.hidden = true;

    root.append(
      this.clockEl,
      this.moneyEl,
      tools,
      zones,
      speeds,
      overlays,
      saves,
      this.statsEl,
      this.warningEl,
      this.lineBar,
    );
  }

  /** Greyed out until there is something to load, so the button never lies. */
  setSaveAvailable(available: boolean): void {
    this.loadButton.disabled = !available;
  }

  update(
    sim: Simulation,
    tool: Tool,
    overlay: Overlay,
    pending: readonly number[],
    notice: string,
  ): void {
    this.clockEl.textContent = sim.clock.format();

    const net = sim.economy.lastDay.net;
    this.moneyEl.textContent = `${formatMoney(sim.economy.balance)}　(${net >= 0 ? '+' : ''}${formatMoney(net)}/日)`;
    this.moneyEl.classList.toggle('negative', sim.economy.balance < 0);

    const world = sim.world;
    const lines = world.activeLines;
    const parts = [
      `人口 ${world.population}`,
      `雇用 ${world.employedCount}/${world.jobCount}`,
      `幸福度 ${Math.round(sim.happiness.breakdown.overall)}`,
    ];
    if (lines.length > 0) {
      const riders = lines.reduce((n, l) => n + l.ridership, 0);
      const waiting = sim.stats.live.waiting;
      parts.push(`路線 ${lines.length}`, `のべ乗車 ${riders}`, `駅で待ち ${waiting}`);
    }
    this.statsEl.textContent = parts.join('　');

    this.warningEl.textContent = notice || this.cityWarning(sim);

    this.lineBar.hidden = tool !== Tool.Line;
    if (tool === Tool.Line) {
      this.lineStatus.textContent = pending.length === 0
        ? '駅を順にクリックしてください（2駅以上）'
        : `選択中: ${pending.length} 駅`;
    }

    for (const [t, b] of this.toolButtons) b.classList.toggle('active', t === tool);
    for (const [o, b] of this.overlayButtons) b.classList.toggle('active', o === overlay);
    this.speedButtons.forEach((b, i) => b.classList.toggle('active', i === sim.clock.speedIndex));
  }

  /**
   * One line, for the most urgent thing wrong with the city. Ordered by what
   * the player has to fix first: a city with no money cannot fix anything
   * else, and unpowered buildings do not work at all, so both come before
   * complaints about the supply chain.
   */
  private cityWarning(sim: Simulation): string {
    if (sim.economy.inOverdraft) {
      return '⚠ 資金がマイナスです（税率を上げるか、維持費を減らすか、借入してください）';
    }
    if (sim.power.report.unpowered > 0) {
      return `⚠ ${sim.power.report.unpowered}件の建物に電気が来ていません（発電所か道路の接続が足りません）`;
    }
    if (sim.chain.report.shopsEmpty > 0) {
      return `⚠ ${sim.chain.report.shopsEmpty}軒の商店に売る商品がありません（工業・一次産業と道路で繋いでください）`;
    }
    if (sim.strandedCount > 0) {
      return `⚠ ${sim.strandedCount}人が職場・自宅にたどり着けません（道路が繋がっていません）`;
    }
    if (sim.happiness.lastMigration.movedOut > 0) {
      return `⚠ ${sim.happiness.lastMigration.movedOut}人が街を出ていきました`;
    }
    return '';
  }
}

const OVERLAY_LABELS: ReadonlyArray<[Overlay, string]> = [
  ['none', '通常 (0)'],
  ['traffic', '渋滞 (T)'],
  ['power', '電力 (P)'],
  ['noise', '騒音 (N)'],
  ['landValue', '地価 (V)'],
];

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
