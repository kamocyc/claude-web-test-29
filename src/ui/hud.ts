import { SPEED_MULTIPLIERS } from '../config';
import type { Simulation } from '../sim/simulation';
import { Tool, TOOL_LABELS } from './tools';

export interface HudCallbacks {
  onTool(tool: Tool): void;
  onSpeed(index: number): void;
  onToggleZones(): void;
  onToggleTraffic(): void;
  onPickRandom(): void;
}

export class Hud {
  private readonly clockEl: HTMLElement;
  private readonly statsEl: HTMLElement;
  private readonly warningEl: HTMLElement;
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

    root.append(this.clockEl, tools, speeds, overlays, this.statsEl, this.warningEl);
  }

  update(sim: Simulation, tool: Tool): void {
    this.clockEl.textContent = sim.clock.format();

    const world = sim.world;
    this.statsEl.textContent =
      `人口 ${world.population}　雇用 ${world.employedCount}/${world.jobCount}`;

    this.warningEl.textContent = sim.strandedCount > 0
      ? `⚠ ${sim.strandedCount}人が職場・自宅にたどり着けません（道路が繋がっていません）`
      : '';

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
