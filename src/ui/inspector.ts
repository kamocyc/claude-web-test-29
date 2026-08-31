import { CAR_FREE_SPEED } from '../config';
import { ticksToMinutes } from '../core/clock';
import { tileX, tileY } from '../core/grid';
import { BuildingType, CitizenState, TravelMode } from '../core/types';
import type { Citizen } from '../sim/citizen';
import { departForHomeMinute, departForWorkMinute } from '../sim/schedule';
import type { Simulation } from '../sim/simulation';

/**
 * The panel the whole game exists for: one citizen, what they are doing, and
 * why. Every number here is read straight off the simulation rather than
 * re-derived, so what the panel claims and what the dot on the map does cannot
 * drift apart.
 */
export class Inspector {
  private readonly body: HTMLElement;
  private readonly followBox: HTMLInputElement;

  selected: Citizen | null = null;

  constructor(root: HTMLElement) {
    root.innerHTML = '';

    const title = document.createElement('h2');
    title.textContent = '市民';

    const follow = document.createElement('label');
    follow.className = 'follow';
    this.followBox = document.createElement('input');
    this.followBox.type = 'checkbox';
    follow.append(this.followBox, document.createTextNode(' カメラで追う'));

    this.body = document.createElement('div');
    this.body.className = 'inspector-body';

    root.append(title, follow, this.body);
  }

  get following(): boolean {
    return this.followBox.checked && this.selected !== null;
  }

  select(c: Citizen | null): void {
    this.selected = c;
  }

  update(sim: Simulation): void {
    const c = this.selected;
    if (!c) {
      this.body.innerHTML = '<p class="empty">市民をクリックすると、その人の一日を追えます。<br>×0.25 の観察速度と「カメラで追う」を組み合わせると、通勤を最初から最後まで見届けられます。</p>';
      return;
    }

    const world = sim.world;
    const home = world.buildings[c.home];
    const work = c.work >= 0 ? world.buildings[c.work] : null;

    const rows: Array<[string, string]> = [
      ['名前', `${c.name} (${c.age}歳)`],
      ['状態', stateLabel(c)],
      ['自宅', home ? address(home.tile) : '—'],
      ['職場', work ? address(work.tile) : '未就業'],
      ['出勤', formatMinute(departForWorkMinute(c.id))],
      ['退勤', formatMinute(departForHomeMinute(c.id))],
    ];

    if (c.path && (c.state === CitizenState.ToWork || c.state === CitizenState.ToHome)) {
      const target = world.buildings[c.destination];
      const remaining = c.path.length - 1 - c.s;
      const arrival = sim.estimateArrivalMinute(c);

      rows.push(['移動手段', c.mode === TravelMode.Car ? '車' : '徒歩']);
      rows.push(['目的地', target ? `${buildingLabel(target.type)} ${address(target.tile)}` : '—']);
      rows.push(['残り距離', `${Math.round(remaining)} タイル`]);
      rows.push(['到着予定', arrival === null ? '—' : formatMinute(arrival)]);
      rows.push([
        '経過',
        `${Math.round(ticksToMinutes(sim.clock.tick - c.tripStartTick))} 分`,
      ]);

      if (c.mode === TravelMode.Car) {
        const ratio = c.v / CAR_FREE_SPEED;
        rows.push(['速度', `${Math.round(ratio * 100)}% ${speedNote(ratio, c.blockedTicks)}`]);
      }
    }

    this.body.innerHTML = '';
    const dl = document.createElement('dl');
    for (const [k, v] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      dl.append(dt, dd);
    }
    this.body.appendChild(dl);

    if (c.mode === TravelMode.Car && c.path) {
      this.body.appendChild(speedBar(c.v / CAR_FREE_SPEED));
    }
  }
}

function stateLabel(c: Citizen): string {
  switch (c.state) {
    case CitizenState.AtHome:
      return '在宅';
    case CitizenState.AtWork:
      return '勤務中';
    case CitizenState.ToWork:
      return '通勤中（職場へ）';
    case CitizenState.ToHome:
      return '帰宅中';
    case CitizenState.Stranded:
      return '⚠ 経路なし（道路が繋がっていません）';
  }
}

function speedNote(ratio: number, blockedTicks: number): string {
  if (blockedTicks > 30) return '（渋滞で停止中）';
  if (ratio < 0.15) return '（ほぼ停止）';
  if (ratio < 0.6) return '（減速中）';
  return '';
}

function speedBar(ratio: number): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'speed-bar';
  const fill = document.createElement('div');
  fill.style.width = `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`;
  wrap.appendChild(fill);
  return wrap;
}

function buildingLabel(t: BuildingType): string {
  return t === BuildingType.Residence ? '住宅' : '職場';
}

function address(tile: number): string {
  return `(${tileX(tile)}, ${tileY(tile)})`;
}

function formatMinute(m: number): string {
  const h = String(Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return `${h}:${mm}`;
}
