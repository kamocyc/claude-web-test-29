import type { ToolMode, ToolStatus } from '../track/app/buildTool';
import { ZONE_LABELS, ZONE_TYPES, type ZoneType } from '../track/network/zoning';
import { NETWORK_CLASSES } from '../track/network/classes';
import type { WorldStats } from '../track/render/worldBuilder';
import { formatMoney } from '../ui/money';
import type { ViewMode } from './app';

/**
 * The chrome: the city's vital signs on top, what you can build along the
 * bottom, and the map in between with nothing on it.
 *
 * The same shape the tile city used, because it was the right shape -- but the
 * bottom bar now carries what the alignment engine actually offers: a class of
 * road or railway to lay, a mode to be in, a use to paint, and the height to
 * lay at. The strip above the row names whatever the pointer is on, and the
 * readout beside it is the *live* state of the tool: the length, radius and
 * grade of the thing being drawn, and why it cannot be placed.
 */

export interface HudCallbacks {
  onMode(mode: ToolMode): void;
  onClass(classId: string): void;
  onZone(zone: ZoneType): void;
  onElevation(steps: number): void;
  onView(view: ViewMode): void;
  onPanel(panel: PanelId): void;
  onStationRotate(steps: number): void;
}

export type PanelId = 'warnings' | 'stats' | 'lines' | 'help';

const MODES: ReadonlyArray<[ToolMode, string, string]> = [
  ['build', '敷設', 'B'],
  ['station', '駅', 'T'],
  ['zone', '区画', 'Z'],
  ['line', '路線', 'L'],
  ['bulldoze', '撤去', 'X'],
  ['inspect', '確認', 'V'],
];

export class Hud {
  private readonly captionEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly statsEl: HTMLElement;
  private readonly warningEl: HTMLElement;
  private readonly modeButtons = new Map<ToolMode, HTMLButtonElement>();
  private readonly classButtons = new Map<string, HTMLButtonElement>();
  private readonly zoneButtons = new Map<ZoneType, HTMLButtonElement>();
  private readonly viewButtons = new Map<ViewMode, HTMLButtonElement>();
  private hovered = '';

  constructor(top: HTMLElement, bottom: HTMLElement, private readonly cb: HudCallbacks) {
    top.innerHTML = '';
    bottom.innerHTML = '';

    this.statsEl = el('div', 'hud-chips');
    this.warningEl = el('div', 'hud-warning');
    const warningButton = document.createElement('button');
    warningButton.className = 'hud-warning-button';
    warningButton.appendChild(this.warningEl);
    warningButton.addEventListener('click', () => this.cb.onPanel('warnings'));

    this.statusEl = el('div', 'hud-clock');
    top.append(this.statusEl, this.statsEl, warningButton);

    this.captionEl = el('div', 'toolbar-caption');
    const row = el('div', 'toolbar-row');

    const modes = group('モード');
    for (const [mode, label, key] of MODES) {
      const b = textButton(`${label}`, `${label} (${key})`, () => this.cb.onMode(mode));
      modes.body.appendChild(b);
      this.modeButtons.set(mode, b);
    }

    const roads = group('道路');
    const rails = group('線路');
    for (const cls of NETWORK_CLASSES) {
      const b = textButton(cls.label, `${cls.label}（設計 ${cls.designSpeed} km/h）`, () => {
        this.cb.onClass(cls.id);
      });
      (cls.kind === 'road' ? roads : rails).body.appendChild(b);
      this.classButtons.set(cls.id, b);
    }

    const zones = group('区画');
    for (const zone of ZONE_TYPES) {
      const b = textButton(ZONE_LABELS[zone], `${ZONE_LABELS[zone]}を塗る`, () => {
        this.cb.onZone(zone);
      });
      b.classList.add('zone-button');
      zones.body.appendChild(b);
      this.zoneButtons.set(zone, b);
    }

    const height = group('高さ');
    height.body.append(
      textButton('＋3m', '敷設高さを上げる (PageUp)', () => this.cb.onElevation(1)),
      textButton('−3m', '敷設高さを下げる (PageDown)', () => this.cb.onElevation(-1)),
      textButton('駅を回す', '駅の向きを15°回す (N / M)', () => this.cb.onStationRotate(1)),
    );

    const views = group('表示');
    for (const [view, label] of [['3d', '3D'], ['plan', '平面']] as const) {
      const b = textButton(label, `${label}表示に切り替える (Tab)`, () => this.cb.onView(view));
      views.body.appendChild(b);
      this.viewButtons.set(view, b);
    }

    const windows = group('ウィンドウ');
    windows.body.append(
      textButton('警告', '警告の一覧', () => this.cb.onPanel('warnings')),
      textButton('統計', '街の統計', () => this.cb.onPanel('stats')),
      textButton('路線', '路線の一覧と編集', () => this.cb.onPanel('lines')),
      textButton('遊びかた', '操作の説明', () => this.cb.onPanel('help')),
    );

    row.append(
      modes.root, roads.root, rails.root, zones.root, height.root, views.root, windows.root,
    );
    bottom.append(this.captionEl, row);

    row.addEventListener('mouseover', (e) => {
      const button = (e.target as HTMLElement).closest('button');
      this.hovered = button?.dataset.label ?? '';
    });
    row.addEventListener('mouseleave', () => {
      this.hovered = '';
    });
    row.addEventListener('wheel', (e) => {
      if (row.scrollWidth <= row.clientWidth) return;
      e.preventDefault();
      row.scrollLeft += e.deltaY + e.deltaX;
    }, { passive: false });
  }

  /** Refresh from the tool and the world. Called once a frame. */
  update(status: ToolStatus, stats: WorldStats | null, view: ViewMode, warning: string): void {
    for (const [mode, b] of this.modeButtons) b.classList.toggle('active', mode === status.mode);
    for (const [id, b] of this.classButtons) b.classList.toggle('active', id === status.classId);
    for (const [zone, b] of this.zoneButtons) b.classList.toggle('active', zone === status.zone);
    for (const [id, b] of this.viewButtons) b.classList.toggle('active', id === view);

    this.captionEl.textContent = this.hovered
      || (status.drawing ? '始点を置きました。次のクリックで確定します' : caption(status));

    // What the tool is doing right now, in the numbers a surveyor would ask
    // for: how long, how tight, how steep, and what it costs.
    const parts: string[] = [];
    if (status.elevation !== 0) parts.push(`敷設高さ ${status.elevation > 0 ? '+' : ''}${status.elevation.toFixed(0)}m`);
    if (status.drawing) {
      parts.push(`延長 ${status.length.toFixed(0)}m`);
      if (Number.isFinite(status.radius)) parts.push(`R${status.radius.toFixed(0)}m`);
      parts.push(`勾配 ${(status.grade * 100).toFixed(1)}%`);
      if (status.cost > 0) parts.push(formatMoney(status.cost));
    }
    this.statusEl.textContent = parts.join('　');

    this.statsEl.innerHTML = '';
    if (stats) {
      for (const [label, value] of [
        ['道路・線路', `${(stats.totalLength / 1000).toFixed(2)} km`],
        ['交差点', `${stats.intersections}`],
        ['駅', `${stats.stations}`],
        ['建物', `${stats.buildings}`],
        ['路線', `${stats.lines}`],
      ] as const) {
        const chip = el('div', 'chip');
        const name = el('span', 'chip-label');
        name.textContent = label;
        const v = el('span', 'chip-value');
        v.textContent = value;
        chip.append(name, v);
        this.statsEl.appendChild(chip);
      }
    }

    const blockers = status.blockers.length > 0 ? status.blockers[0] : '';
    this.warningEl.textContent = blockers || warning || '順調です';
    this.warningEl.className = 'hud-warning' + (blockers ? ' critical' : warning ? ' warning' : '');
  }
}

function caption(status: ToolStatus): string {
  const mode = MODES.find(([id]) => id === status.mode);
  return mode ? `${mode[1]} を選択中` : '';
}

function el(tag: string, cls: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = cls;
  return node;
}

function textButton(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'tool-button text';
  b.textContent = label;
  b.dataset.label = title;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.addEventListener('click', onClick);
  return b;
}

function group(name: string): { root: HTMLElement; body: HTMLElement } {
  const root = el('div', 'tool-group');
  const caption = el('span', 'tool-group-label');
  caption.textContent = name;
  const body = el('div', 'tool-group-body');
  root.append(caption, body);
  return { root, body };
}
