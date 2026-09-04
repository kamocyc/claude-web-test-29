import type { ToolMode, ToolStatus } from '../track/app/buildTool';
import { ZONE_LABELS, ZONE_TYPES, type ZoneType } from '../track/network/zoning';
import { NETWORK_CLASSES } from '../track/network/classes';
import type { WorldStats } from '../track/render/worldBuilder';
import { formatMoney } from '../ui/money';
import type { BuildingType } from '../core/types';
import { CIVIC_KINDS } from './civic';
import type { ViewMode } from './app';
import { SPEEDS, type CityStats } from './simulation';
import type { Treasury } from './economy';

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
  onSpeed(index: number): void;
  onMode(mode: ToolMode): void;
  onClass(classId: string): void;
  onZone(zone: ZoneType): void;
  onElevation(steps: number): void;
  onView(view: ViewMode): void;
  onPanel(panel: PanelId): void;
  onStationRotate(steps: number): void;
  onCivic(type: BuildingType): void;
  onSave(): void;
  onLoad(): void;
  onNew(): void;
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
  private readonly civicButtons = new Map<BuildingType, HTMLButtonElement>();
  private readonly speedButtons: HTMLButtonElement[] = [];
  private readonly clockEl: HTMLElement;
  private readonly moneyEl: HTMLElement;
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

    this.statusEl = el('div', 'hud-tool-status');
    this.clockEl = el('div', 'hud-clock');
    this.moneyEl = el('div', 'hud-money');

    const speeds = el('div', 'hud-group hud-speeds');
    SPEEDS.forEach((multiplier, i) => {
      const b = document.createElement('button');
      b.className = 'speed-button';
      b.textContent = multiplier === 0 ? '‖' : `×${multiplier}`;
      b.title = multiplier === 0 ? '一時停止' : `速度 ×${multiplier}`;
      b.addEventListener('click', () => this.cb.onSpeed(i));
      speeds.appendChild(b);
      this.speedButtons.push(b);
    });

    top.append(this.clockEl, this.moneyEl, this.statusEl, this.statsEl, warningButton, speeds);

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

    const civic = group('施設');
    for (const kind of CIVIC_KINDS) {
      const b = textButton(
        kind.label,
        `${kind.label}（${formatMoney(kind.cost)}・範囲 ${kind.reach} m）`,
        () => this.cb.onCivic(kind.type),
      );
      civic.body.appendChild(b);
      this.civicButtons.set(kind.type, b);
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

    const saves = group('街');
    saves.body.append(
      textButton('保存', 'この街を保存する (Ctrl+S)', () => this.cb.onSave()),
      textButton('読込', '保存した街を開く', () => this.cb.onLoad()),
      textButton('新規', '新しい街を始める', () => this.cb.onNew()),
    );

    const windows = group('ウィンドウ');
    windows.body.append(
      textButton('警告', '警告の一覧', () => this.cb.onPanel('warnings')),
      textButton('統計', '街の統計', () => this.cb.onPanel('stats')),
      textButton('路線', '路線の一覧と編集', () => this.cb.onPanel('lines')),
      textButton('遊びかた', '操作の説明', () => this.cb.onPanel('help')),
    );

    row.append(
      modes.root, roads.root, rails.root, zones.root, civic.root, height.root,
      views.root, saves.root, windows.root,
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

  /** Refresh from the tool, the world and the city. Called once a frame. */
  update(
    status: ToolStatus,
    stats: WorldStats | null,
    city: CityStats,
    treasury: Treasury,
    clock: string,
    speed: number,
    view: ViewMode,
    warning: string,
    civicType: BuildingType | null = null,
  ): void {
    this.clockEl.textContent = clock;
    this.moneyEl.textContent = `${formatMoney(treasury.balance)}　(${
      treasury.lastDay.net >= 0 ? '+' : ''}${formatMoney(treasury.lastDay.net)}/日)`;
    this.moneyEl.classList.toggle('negative', treasury.inOverdraft);
    this.speedButtons.forEach((b, i) => b.classList.toggle('active', i === speed));
    for (const [mode, b] of this.modeButtons) b.classList.toggle('active', mode === status.mode);
    for (const [id, b] of this.classButtons) b.classList.toggle('active', id === status.classId);
    for (const [zone, b] of this.zoneButtons) b.classList.toggle('active', zone === status.zone);
    for (const [id, b] of this.viewButtons) b.classList.toggle('active', id === view);
    for (const [type, b] of this.civicButtons) b.classList.toggle('active', type === civicType);
    // Holding a hospital is not being in build mode, whatever the tool says.
    if (civicType !== null) for (const b of this.modeButtons.values()) b.classList.remove('active');

    this.captionEl.textContent = this.hovered
      || (civicType !== null
        ? `${CIVIC_KINDS.find((k) => k.type === civicType)?.label ?? ''}を置く場所をクリック`
        : status.drawing
          ? '始点を置きました。次のクリックで確定します'
          : caption(status));

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
        ['人口', `${city.population}`],
        ['雇用', `${city.employed}/${city.jobs}`],
        ['幸福度', `${Math.round(city.happiness)}`],
        ['移動中', `${city.travelling}${city.stranded > 0 ? ` ⚠${city.stranded}` : ''}`],
        ['公共交通', `${city.onTransit}`],
        ['平均通勤', city.meanCommute > 0 ? `${Math.round(city.meanCommute)} 分` : '—'],
        ['道路・線路', `${(stats.totalLength / 1000).toFixed(2)} km`],
        // The city's own count, not the engine's: the engine counts plots a
        // building *could* stand on, and the city has only built some of them.
        ['建物', `${city.buildings}`],
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
