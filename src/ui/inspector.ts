import { CAR_FREE_SPEED, TRAIN_CAPACITY } from '../config';
import { ticksToMinutes } from '../core/clock';
import { tileX, tileY } from '../core/grid';
import { BuildingType, CitizenState, TravelMode } from '../core/types';
import type { Citizen } from '../sim/citizen';
import { departForHomeMinute, departForWorkMinute } from '../sim/schedule';
import type { Simulation } from '../sim/simulation';
import { industryOf, isHome, specFor, type Building } from '../world/buildings';
import { Industry } from '../core/types';
import { ZONE_LABELS } from '../world/zoneRules';

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
  /** A building the player clicked instead of a citizen. */
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
      const b = this.selectedStation;
      this.title.textContent = b.type === BuildingType.Station ? '駅' : BUILDING_LABELS[b.type];
      if (b.type === BuildingType.Station) this.updateStation(sim, b);
      else this.updateBuilding(sim, b);
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
      ['幸福度', c.happiness < 0 ? '—' : `${Math.round(c.happiness)} / 100${moodNote(c)}`],
      ['自宅', home ? address(home.tile) : '—'],
      ['職場', work ? address(work.tile) : '未就業'],
      ['出勤', formatMinute(departForWorkMinute(c.seed))],
      ['退勤', formatMinute(departForHomeMinute(c.seed))],
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

    // Why this person feels the way they do, in the same terms the city-wide
    // panel uses, so an unhappy citizen can be traced to a specific failure.
    if (home && home.alive) {
      this.body.appendChild(subheading('住環境'));
      this.body.appendChild(definitionList([
        ['地価', `${Math.round(sim.landValue.at(home.tile))} / 100`],
        ['騒音', `${Math.round(sim.noise.at(home.tile))} / 100`],
        ['電気', home.powered ? '来ている' : '来ていない'],
        ['買い物', `${Math.round(sim.chain.serviceLevel(world) * 100)}% 供給`],
      ]));
    }
  }

  /**
   * Any building other than a station: what it employs, what it is powered by
   * and -- for anything in the supply chain -- what it has to work with. A
   * factory sitting idle should be able to say so itself.
   */
  private updateBuilding(sim: Simulation, b: Building): void {
    if (!sim.world.isAlive(b)) {
      this.body.innerHTML = '<p class="empty">この建物は撤去されました。</p>';
      return;
    }
    const spec = specFor(b.type);
    const rows: Array<[string, string]> = [
      ['場所', address(b.tile)],
      [isHome(b.type) ? '居住者' : '従業員', `${b.occupants.length} / ${b.capacity} 人`],
      ['電気', b.powered ? `来ている（${spec.power}）` : '⚠ 来ていない'],
      ['地価', `${Math.round(sim.landValue.at(b.tile))} / 100`],
      ['騒音', `${Math.round(sim.noise.at(b.tile))} / 100`],
    ];

    const industry = industryOf(b.type);
    if (industry === Industry.Primary) {
      rows.push(['採れた資源', `${b.goodsStock.toFixed(0)} / ${spec.storage}`]);
    } else if (industry === Industry.Secondary) {
      rows.push(['原材料', `${b.rawStock.toFixed(0)} / ${spec.storage}`]);
      rows.push(['製品', `${b.goodsStock.toFixed(0)} / ${spec.storage}`]);
    } else if (industry === Industry.Retail) {
      rows.push(['在庫', `${b.goodsStock.toFixed(0)} / ${spec.storage}`]);
      rows.push(['本日の販売', `${b.soldToday.toFixed(0)}`]);
    }
    if (b.starvedHours > 0) {
      rows.push(['稼働できない時間', `${b.starvedHours} 時間`]);
    }
    if (spec.upkeep > 0) {
      rows.push(['維持費', `¥${spec.upkeep.toLocaleString('ja-JP')} / 日`]);
    }

    this.body.innerHTML = '';
    this.body.appendChild(definitionList(rows));
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
      ['電気', station.powered ? '来ている' : '⚠ 来ていない'],
      ['区画', ZONE_LABELS[world.map.getZone(station.tile)]],
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

function subheading(text: string): HTMLElement {
  const h = document.createElement('h3');
  h.textContent = text;
  return h;
}

const BUILDING_LABELS: Record<BuildingType, string> = {
  [BuildingType.House]: '低密度住宅',
  [BuildingType.Apartment]: '高密度住宅',
  [BuildingType.Shop]: '商店',
  [BuildingType.Factory]: '工場',
  [BuildingType.Office]: 'オフィス',
  [BuildingType.Farm]: '水田',
  [BuildingType.ForestryCamp]: '林業所',
  [BuildingType.FishingWharf]: '漁港',
  [BuildingType.Mine]: '鉱山',
  [BuildingType.Station]: '駅',
  [BuildingType.PowerPlant]: '発電所',
};

function moodNote(c: Citizen): string {
  if (c.happiness >= 70) return '（満足）';
  if (c.happiness >= 50) return '（まあまあ）';
  if (c.happiness >= 30) return '（不満）';
  return `（限界。${c.unhappyHours}時間 我慢中）`;
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
  return BUILDING_LABELS[t];
}

function address(tile: number): string {
  return `(${tileX(tile)}, ${tileY(tile)})`;
}

function formatMinute(m: number): string {
  const h = String(Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return `${h}:${mm}`;
}
