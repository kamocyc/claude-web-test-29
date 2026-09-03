import { TravelMode } from '../core/types';
import type { Simulation } from '../sim/simulation';
import type { LiveStats, TripStats } from '../sim/statistics';
import { vacantDwellings } from '../sim/happiness';
import { ticksToMinutes } from '../core/clock';
import { bar, note, row, section } from './widgets';
import { LineMode } from '../world/transit';
import { BUS_ID_BASE } from '../sim/bus';

/** Shown by the window's "？". */
export const STATS_HELP = '上半分はいまこの瞬間の市民の内訳、下半分は完了した移動の実績です。'
  + '「移動中」が多いのに平均所要が伸びていれば、街は忙しいのではなく詰まっています。';

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
    this.body = document.createElement('div');
    this.body.className = 'stats-body';
    root.append(this.body);
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
        bar('在宅', live.atHome, live.population, '#8ed64a'),
        bar('勤務中', live.atWork, live.population, '#e0c33c'),
        bar('移動中', live.travelling, live.population, '#4ade80'),
        bar('買い物中', live.shopping, live.population, '#4fa3e3'),
        bar('レジャー中', live.leisure, live.population, '#5fd18a'),
        bar('駅で待ち', live.waiting, live.population, '#c58fe0'),
        bar('乗車中', live.riding, live.population, '#9b8ce0'),
        bar('経路なし', live.stranded, live.population, '#ff5252'),
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
    bar('　住環境', Math.round(h.housing), 100, '#8ed64a'),
    bar('　通勤', Math.round(h.commute), 100, '#e0c33c'),
    bar('　雇用', Math.round(h.employment), 100, '#4ade80'),
    bar('　食料', Math.round(h.services), 100, '#4fa3e3'),
    bar('　電気', Math.round(h.power), 100, '#f2d64b'),
    bar('　治安', Math.round(h.safety), 100, '#b45cf0'),
    bar('　公共', Math.round(h.civic), 100, '#7ec8a9'),
    bar('　レジャー', Math.round(h.leisure), 100, '#5fd18a'),
    bar('　健康', Math.round(h.health), 100, '#e8f0f5'),
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
    row('電力', `供給 ${Math.round(power.supply)} ／ 需要 ${Math.round(power.demand)}`),
    row('　不足', power.shortfall > 0 ? `${Math.round(power.shortfall)}` : 'なし',
      power.shortfall > 0),
    row('　停電中の建物', `${power.unpowered} 件`, power.unpowered > 0),
    row('平均地価', `${Math.round(sim.landValue.meanResidential(sim.world))} / 100`),
    row('平均犯罪度', `${Math.round(sim.crime.meanResidential(sim.world))} / 100`),
    row('平均学歴', `${Math.round(sim.services.report.education)} / 100`),
    row('平均健康', `${Math.round(sim.services.report.health)} / 100`),
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
  if (score >= 60) return '#4ade80';
  if (score >= 40) return '#ffb02e';
  return '#ff5252';
}

function modeRows(live: LiveStats): HTMLElement[] {
  const travelling = live.walking + live.driving + live.usingTransit;
  if (travelling === 0) return [note('外出中の市民なし')];
  return [
    bar('徒歩', live.walking, travelling, '#e8eef5'),
    bar('車', live.driving, travelling, '#e0c33c'),
    bar('電車', live.usingTransit, travelling, '#c58fe0'),
  ];
}

/** Per-line ridership, plus how many people are stood on its platforms. */
function lineSection(sim: Simulation): HTMLElement {
  const lines = sim.world.activeLines;
  if (lines.length === 0) {
    return section('路線・系統', [note('路線なし')]);
  }

  const rows = lines.map((line) => {
    let aboard = 0;
    for (const id of line.vehicles) {
      const vehicle = line.mode === LineMode.Rail
        ? sim.world.trains[id]
        : sim.world.buses[id - BUS_ID_BASE];
      aboard += vehicle?.passengers.length ?? 0;
    }
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
  return section('路線・系統', rows);
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
