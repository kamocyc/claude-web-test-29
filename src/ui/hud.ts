import { SPEED_MULTIPLIERS } from '../config';
import type { Simulation } from '../sim/simulation';
import { Tool, TOOL_LABELS } from './tools';

export interface HudCallbacks {
  onTool(tool: Tool): void;
  onSpeed(index: number): void;
  onToggleZones(): void;
  onToggleTraffic(): void;
  onPickRandom(): void;
  onCommitLine(): void;
  onCancelLine(): void;
  onSave(): void;
  onLoad(): void;
}

export class Hud {
  private readonly clockEl: HTMLElement;
  private readonly statsEl: HTMLElement;
  private readonly warningEl: HTMLElement;
  private readonly lineBar: HTMLElement;
  private readonly lineStatus: HTMLElement;
  private readonly loadButton: HTMLButtonElement;
  private readonly toolButtons = new Map<Tool, HTMLButtonElement>();
  private readonly speedButtons: HTMLButtonElement[] = [];

  constructor(root: HTMLElement, private readonly cb: HudCallbacks) {
    root.innerHTML = '';

    this.clockEl = el('div', 'hud-clock');
    this.statsEl = el('div', 'hud-stats');
    this.warningEl = el('div', 'hud-warning');

    const tools = el('div', 'hud-group');
    for (const { tool, label, key } of TOOL_LABELS) {
      const b = document.createElement('button');
      b.textContent = `${label} (${key})`;
      b.addEventListener('click', () => this.cb.onTool(tool));
      tools.appendChild(b);
      this.toolButtons.set(tool, b);
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
    overlays.appendChild(button('渋滞 (T)', () => this.cb.onToggleTraffic()));
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
      tools,
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

  update(sim: Simulation, tool: Tool, pending: readonly number[], notice: string): void {
    this.clockEl.textContent = sim.clock.format();

    const world = sim.world;
    const lines = world.activeLines;
    const parts = [`人口 ${world.population}`, `雇用 ${world.employedCount}/${world.jobCount}`];
    if (lines.length > 0) {
      const riders = lines.reduce((n, l) => n + l.ridership, 0);
      const waiting = sim.stats.live.waiting;
      parts.push(`路線 ${lines.length}`, `のべ乗車 ${riders}`, `駅で待ち ${waiting}`);
    }
    this.statsEl.textContent = parts.join('　');

    this.warningEl.textContent = notice
      || (sim.strandedCount > 0
        ? `⚠ ${sim.strandedCount}人が職場・自宅にたどり着けません（道路が繋がっていません）`
        : '');

    this.lineBar.hidden = tool !== Tool.Line;
    if (tool === Tool.Line) {
      this.lineStatus.textContent = pending.length === 0
        ? '駅を順にクリックしてください（2駅以上）'
        : `選択中: ${pending.length} 駅`;
    }

    for (const [t, b] of this.toolButtons) b.classList.toggle('active', t === tool);
    this.speedButtons.forEach((b, i) => b.classList.toggle('active', i === sim.clock.speedIndex));
  }
}

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
