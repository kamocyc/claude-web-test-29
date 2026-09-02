import { TravelMode } from '../core/types';
import type { Simulation } from '../sim/simulation';
import type { LiveStats, TripStats } from '../sim/statistics';
import { vacantDwellings } from '../sim/happiness';
import { ticksToMinutes } from '../core/clock';

/** Rebuilt a few times a second; every frame would be wasted DOM work. */
const REFRESH_MS = 250;

/**
 * The population panel: what everyone is doing right now, how they are
 * getting there, and what the trips that have already finished actually cost.
 *
 * The split matters. A city can look busy and be failing -- hundreds of people
 * moving, all of them in a queue -- and the only way to see that is the mean
 * travel time of completed trips next to the live census. Both come straight
 * off the simulation's own counters, so the panel cannot disagree with the map.
 */
export class StatsPanel {
  private readonly body: HTMLElement;
  private lastDraw = 0;

  constructor(root: HTMLElement) {
    root.innerHTML = '';
    const title = document.createElement('h2');
    title.textContent = '市民の統計';
    this.body = document.createElement('div');
    this.body.className = 'stats-body';
    root.append(title, this.body);
  }

  update(sim: Simulation, now = performance.now()): void {
    if (now - this.lastDraw < REFRESH_MS) return;
    this.lastDraw = now;

    const live = sim.stats.live;
    const trips = sim.stats.trips();

    this.body.innerHTML = '';
    this.body.append(
      section('人口', [
        row('人口', `${live.population} 人`),
        row('就業', `${live.employed} / ${live.population} 人${percentSuffix(live.employed, live.population)}`),
        row('求人', `${sim.world.jobCount - sim.world.employedCount} 件`),
      ]),
      section('いま何をしているか', [
        bar('在宅', live.atHome, live.population, '#5fa8d3'),
        bar('勤務中', live.atWork, live.population, '#e0a458'),
        bar('移動中', live.travelling, live.population, '#3ddc7f'),
        bar('買い物中', live.shopping, live.population, '#8fc95c'),
    bar('駅で待ち', live.waiting, live.population, '#c8b6e2'),
        bar('乗車中', live.riding, live.population, '#8f7fd6'),
        bar('経路なし', live.stranded, live.population, '#ff4d5e'),
      ]),
      section('移動手段（外出中）', modeRows(live)),
      wellbeingSection(sim),
      freightSection(sim),
      citySection(sim),
      section('完了した移動', [
        row('のべ件数', `${trips.completed} 件`),
        row('平均所要', minutes(trips.meanMinutes)),
        row('　徒歩', tripMode(trips, TravelMode.Walk)),
        row('　車', tripMode(trips, TravelMode.Car)),
        row('　電車', tripMode(trips, TravelMode.Transit)),
        row('平均待ち時間', minutes(trips.meanWaitMinutes)),
      ]),
      lineSection(sim),
    );
  }
}

/** How the residents feel, in the same terms the happiness model uses. */
function wellbeingSection(sim: Simulation): HTMLElement {
  const h = sim.happiness.breakdown;
  const migration = sim.happiness.lastMigration;
  return section('幸福度', [
    bar('総合', Math.round(h.overall), 100, moodColor(h.overall)),
    bar('　住環境', Math.round(h.housing), 100, '#5fa8d3'),
    bar('　通勤', Math.round(h.commute), 100, '#e0a458'),
    bar('　雇用', Math.round(h.employment), 100, '#3ddc7f'),
    bar('　食料', Math.round(h.services), 100, '#d99ae0'),
    bar('　電気', Math.round(h.power), 100, '#f0d24a'),
    row('直近1時間の移住', `+${migration.movedIn} / -${migration.movedOut} 人`),
    row('住宅の空き', `${vacantDwellings(sim.world)} 戸`),
  ]);
}

/** The lorries: how much of the city's freight is actually moving. */
function freightSection(sim: Simulation): HTMLElement {
  const f = sim.freight.report;
  const fleet = sim.world.lorries.length;
  return section('物流', [
    row('走行中のトラック', `${f.onTheRoad} / ${fleet} 台`),
    row('輸送中の商品', `${Math.round(f.inTransit)} 単位`),
    row('本日の配送', `${f.deliveriesToday} 件 ／ ${Math.round(f.deliveredToday)} 単位`),
    row('平均配送時間', f.meanDeliveryTicks === 0
      ? '—'
      : `${Math.round(ticksToMinutes(f.meanDeliveryTicks))} 分`),
    row('届いていない需要', `${Math.round(f.unmetDemand)} 単位`),
    row('立ち往生', `${f.stuck} 台`),
  ]);
}

/** Power, land value and the supply chain: the city's own vital signs. */
function citySection(sim: Simulation): HTMLElement {
  const power = sim.power.report;
  const chain = sim.chain.report;
  const rows = [
    row('電力', `需要 ${Math.round(power.demand)} ／ 供給 ${Math.round(power.supply)}`),
    row('　停電中の建物', `${power.unpowered} 件`),
    row('平均地価', `${Math.round(sim.landValue.meanResidential(sim.world))} / 100`),
    row('食料のある世帯', `${Math.round(sim.chain.serviceLevel(sim.world) * 100)}%`),
    row('　一次産業の産出', `${chain.rawProduced.toFixed(0)} / 時`),
    row('　工場の生産', `${chain.goodsProduced.toFixed(0)} / 時`),
    row('　住民の購入', `${chain.goodsSold.toFixed(0)} / 時`),
    row('　在庫切れの商店', `${chain.shopsEmpty} 軒`),
    row('　原料切れの工場', `${chain.factoriesIdle} 軒`),
  ];
  return section('都市の状態', rows);
}

function moodColor(score: number): string {
  if (score >= 60) return '#3ddc7f';
  if (score >= 40) return '#e0a458';
  return '#ff4d5e';
}

function modeRows(live: LiveStats): HTMLElement[] {
  const travelling = live.walking + live.driving + live.usingTransit;
  if (travelling === 0) return [note('いま外出している市民はいません')];
  return [
    bar('徒歩', live.walking, travelling, '#d8dee9'),
    bar('車', live.driving, travelling, '#e0a458'),
    bar('電車', live.usingTransit, travelling, '#4ea3e0'),
  ];
}

/** Per-line ridership, plus how many people are stood on its platforms. */
function lineSection(sim: Simulation): HTMLElement {
  const lines = sim.world.activeLines;
  if (lines.length === 0) {
    return section('路線', [note('路線がありません。駅を2つ以上選んで路線を作れます。')]);
  }

  const rows = lines.map((line) => {
    let aboard = 0;
    for (const id of line.trains) aboard += sim.world.trains[id]?.passengers.length ?? 0;
    let waiting = 0;
    for (const station of line.stations) waiting += sim.stats.waitingAt(station);

    const el = row(
      line.name,
      `乗車 ${aboard} 人 ／ 待ち ${waiting} 人 ／ のべ ${line.ridership} 人`,
    );
    el.style.setProperty('--line-color', line.color);
    el.classList.add('line-row');
    return el;
  });
  return section('路線', rows);
}

function section(title: string, children: HTMLElement[]): HTMLElement {
  const wrap = document.createElement('section');
  const h = document.createElement('h3');
  h.textContent = title;
  wrap.append(h, ...children);
  return wrap;
}

function row(label: string, value: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'stat-row';
  const k = document.createElement('span');
  k.className = 'stat-key';
  k.textContent = label;
  const v = document.createElement('span');
  v.className = 'stat-value';
  v.textContent = value;
  el.append(k, v);
  return el;
}

/** A labelled proportion bar; the number is always shown next to it. */
function bar(label: string, value: number, total: number, color: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'stat-bar';

  const k = document.createElement('span');
  k.className = 'stat-key';
  k.textContent = label;

  const track = document.createElement('div');
  track.className = 'stat-track';
  const fill = document.createElement('div');
  fill.style.width = `${total === 0 ? 0 : Math.round((value / total) * 100)}%`;
  fill.style.background = color;
  track.appendChild(fill);

  const v = document.createElement('span');
  v.className = 'stat-value';
  v.textContent = `${value}`;

  el.append(k, track, v);
  return el;
}

function note(text: string): HTMLElement {
  const el = document.createElement('p');
  el.className = 'stat-note';
  el.textContent = text;
  return el;
}

function tripMode(trips: TripStats, mode: TravelMode): string {
  const n = trips.countByMode[mode];
  if (n === 0) return '—';
  return `${minutes(trips.meanByMode[mode])}（${n} 件）`;
}

function minutes(value: number): string {
  if (value <= 0) return '—';
  return `${Math.round(value)} 分`;
}

function percentSuffix(value: number, total: number): string {
  if (total === 0) return '';
  return `（${Math.round((value / total) * 100)}%）`;
}
