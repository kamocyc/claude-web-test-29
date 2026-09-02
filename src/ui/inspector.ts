import { CAR_FREE_SPEED, TRAIN_CAPACITY } from '../config';
import { ticksToMinutes } from '../core/clock';
import { tileX, tileY } from '../core/grid';
import { BuildingType, CitizenState, TravelMode } from '../core/types';
import type { Citizen } from '../sim/citizen';
import { departForHomeMinute, departForWorkMinute } from '../sim/schedule';
import type { Simulation } from '../sim/simulation';
import type { Building } from '../world/buildings';

/**
 * The panel the whole game exists for: one citizen, what they are doing, and
 * why. Every number here is read straight off the simulation rather than
 * re-derived, so what the panel claims and what the dot on the map does cannot
 * drift apart.
 */
export class Inspector {
  private readonly title: HTMLElement;
  private readonly body: HTMLElement;
  private readonly followBox: HTMLInputElement;

  selected: Citizen | null = null;
  /** A station the player clicked instead of a citizen. */
  selectedStation: Building | null = null;

  constructor(root: HTMLElement) {
    root.innerHTML = '';

    this.title = document.createElement('h2');
    this.title.textContent = '市民';

    const follow = document.createElement('label');
    follow.className = 'follow';
    this.followBox = document.createElement('input');
    this.followBox.type = 'checkbox';
    follow.append(this.followBox, document.createTextNode(' カメラで追う'));

    this.body = document.createElement('div');
    this.body.className = 'inspector-body';

    root.append(this.title, follow, this.body);
  }

  get following(): boolean {
    return this.followBox.checked && this.selected !== null;
  }

  select(c: Citizen | null): void {
    this.selected = c;
    if (c) this.selectedStation = null;
  }

  selectStation(b: Building | null): void {
    this.selectedStation = b;
    if (b) this.selected = null;
  }

  /** Called after a load, when every id in the panel belongs to an old city. */
  clear(): void {
    this.selected = null;
    this.selectedStation = null;
  }

  update(sim: Simulation): void {
    if (this.selectedStation) {
      this.title.textContent = '駅';
      this.updateStation(sim, this.selectedStation);
      return;
    }
    this.title.textContent = '市民';

    const c = this.selected;
    if (!c) {
      this.body.innerHTML = '<p class="empty">市民をクリックすると、その人の一日を追えます。<br>×0.25 の観察速度と「カメラで追う」を組み合わせると、通勤を最初から最後まで見届けられます。<br><br>電車に乗る市民を選ぶと、駅までの徒歩・ホームでの待ち・乗車・降車後の徒歩がそのまま観察できます。<br><br>駅をクリックすると、待っている人数と発着する路線が見られます。</p>';
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

    if (c.mode === TravelMode.Transit && c.ride) {
      const line = world.lines[c.ride.line];
      const board = world.buildings[c.ride.boardStation];
      const alight = world.buildings[c.ride.alightStation];
      rows.push(['移動手段', '電車']);
      rows.push(['路線', line ? line.name : '—']);
      rows.push(['乗車駅', board ? address(board.tile) : '—']);
      rows.push(['降車駅', alight ? address(alight.tile) : '—']);

      if (c.state === CitizenState.Waiting) {
        const waited = Math.round(ticksToMinutes(sim.clock.tick - c.waitStartTick));
        rows.push(['待ち時間', `${waited} 分`]);
        rows.push(['ホームの人数', `${sim.stats.waitingAt(c.ride.boardStation)} 人`]);
      }
      if (c.state === CitizenState.Riding) {
        const train = world.trains[c.boardedTrain];
        if (train) {
          rows.push(['乗客数', `${train.passengers.length} / ${TRAIN_CAPACITY} 人`]);
        }
      }
    }

    if (c.path && (c.state === CitizenState.ToWork || c.state === CitizenState.ToHome)) {
      const target = world.buildings[c.destination];
      const remaining = c.path.length - 1 - c.s;
      const arrival = sim.estimateArrivalMinute(c);

      if (c.mode !== TravelMode.Transit) {
        rows.push(['移動手段', c.mode === TravelMode.Car ? '車' : '徒歩']);
      }
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
    this.body.appendChild(definitionList(rows));

    if (c.mode === TravelMode.Car && c.path) {
      this.body.appendChild(speedBar(c.v / CAR_FREE_SPEED));
    }
  }

  /**
   * A station: how many people are stood on the platform right now, and what
   * is coming to collect them. The waiting figure is the same counter the map
   * badge draws, so the panel and the badge can never disagree.
   */
  private updateStation(sim: Simulation, station: Building): void {
    const world = sim.world;
    if (!world.isAlive(station)) {
      this.body.innerHTML = '<p class="empty">この駅は撤去されました。</p>';
      return;
    }

    const lines = world.activeLines.filter((l) => l.stations.includes(station.id));
    const rows: Array<[string, string]> = [
      ['場所', address(station.tile)],
      ['待ち人数', `${sim.stats.waitingAt(station.id)} 人`],
      ['乗り入れ路線', lines.length === 0 ? 'なし' : lines.map((l) => l.name).join('、')],
    ];

    for (const line of lines) {
      let aboard = 0;
      for (const id of line.trains) aboard += world.trains[id]?.passengers.length ?? 0;
      rows.push([`${line.name} の列車`, `${line.trains.length} 本 ／ 乗車 ${aboard} 人`]);
      rows.push([`${line.name} のべ乗車`, `${line.ridership} 人`]);
    }

    this.body.innerHTML = '';
    this.body.appendChild(definitionList(rows));

    if (lines.length === 0) {
      const hint = document.createElement('p');
      hint.className = 'empty';
      hint.textContent = '「路線」ツールでこの駅を含む駅を2つ以上選ぶと、路線を開設できます。';
      this.body.appendChild(hint);
    }
  }
}

function definitionList(rows: Array<[string, string]>): HTMLElement {
  const dl = document.createElement('dl');
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dl.append(dt, dd);
  }
  return dl;
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
    case CitizenState.Waiting:
      return '駅で電車を待っている';
    case CitizenState.Riding:
      return '乗車中';
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
