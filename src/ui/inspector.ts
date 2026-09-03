import {
  CAR_FREE_SPEED,
  LEISURE_VISITS_PER_CAPACITY,
  REST_DAYS_PER_WEEK,
  LORRY_CAPACITY,
  MAX_TERRAIN_HEIGHT,
  TRAIN_CAPACITY,
} from '../config';
import { ticksToMinutes } from '../core/clock';
import { tileX, tileY } from '../core/grid';
import { BuildingType, CitizenState, isTravelling, TravelMode } from '../core/types';
import type { Citizen } from '../sim/citizen';
import { CargoKind, LorryState, type Lorry } from '../sim/lorry';
import { departForHomeMinute, departForWorkMinute, isRestDay } from '../sim/schedule';
import type { Simulation } from '../sim/simulation';
import {
  industryOf,
  isHome,
  isLeisure,
  leisureCapacity,
  leisureDraw,
  specFor,
  type Building,
} from '../world/buildings';
import { reach } from '../sim/leisure';
import type { LandValueFactors } from '../sim/landValue';
import { BUILDING_ISSUES, buildingIssue } from '../sim/diagnostics';
import { Industry } from '../core/types';
import { ZONE_LABELS } from '../world/zoneRules';
import { help, HelpState, subheading } from './widgets';
import { isTransitStop } from '../world/buildings';
import { lineSpec, LineMode, type TransitLine } from '../world/transit';
import { IncidentKind } from '../sim/emergency';
import { BUS_ID_BASE } from '../sim/bus';
import { Service } from '../sim/services';
import type { World } from '../world/world';

/** Shown by the window's "？". */
export const INSPECTOR_HELP = '市民・建物・駅・トラックをクリックすると、そのものの現在がここに出ます。'
  + '速度を ×0.25 にして「カメラで追う」を入れると、1人の一日を最初から最後まで追えます。';

/** Behind the "？" on the land value breakdown. */
const LAND_VALUE_HELP = '地価を上げるには、駅と商店を近くに、工場と幹線道路を遠くに。'
  + '水辺・森・高台の眺望も効きます。'
  + '地価が低いと高密度住宅は建たず、住民の幸福度も下がります。';

/** Rebuilt a few times a second, like the other panels, rather than per frame. */
const REFRESH_MS = 250;

/**
 * The panel the whole game exists for: one citizen, what they are doing, and
 * why. Every number here is read straight off the simulation rather than
 * re-derived, so what the panel claims and what the dot on the map does cannot
 * drift apart.
 */
export class Inspector {
  private readonly body: HTMLElement;
  private readonly followBox: HTMLInputElement;
  /** The body is rebuilt as the city runs; its "？" are built once. */
  private readonly helpState = new HelpState();
  private lastDraw = 0;
  /** Set when the selection changes, so a click never waits for the timer. */
  private dirty = true;

  /**
   * What is being inspected, for the window's own title bar. Kept here rather
   * than written into the panel so the title is not repeated inside the body
   * of the window that already carries it.
   */
  title = '詳細';

  selected: Citizen | null = null;
  /** A building the player clicked instead of a citizen. */
  selectedStation: Building | null = null;
  /** A lorry the player clicked. */
  selectedLorry: Lorry | null = null;

  constructor(root: HTMLElement) {
    root.innerHTML = '';

    const follow = document.createElement('label');
    follow.className = 'follow';
    this.followBox = document.createElement('input');
    this.followBox.type = 'checkbox';
    follow.append(this.followBox, document.createTextNode(' カメラで追う'));

    this.body = document.createElement('div');
    this.body.className = 'inspector-body';

    root.append(follow, this.body);
  }

  get following(): boolean {
    return this.followBox.checked && this.selected !== null;
  }

  select(c: Citizen | null): void {
    this.dirty = true;
    this.selected = c;
    if (c) {
      this.selectedStation = null;
      this.selectedLorry = null;
    }
  }

  selectStation(b: Building | null): void {
    this.dirty = true;
    this.selectedStation = b;
    if (b) {
      this.selected = null;
      this.selectedLorry = null;
    }
  }

  selectLorry(l: Lorry | null): void {
    this.dirty = true;
    this.selectedLorry = l;
    if (l) {
      this.selected = null;
      this.selectedStation = null;
    }
  }

  /** Called after a load, when every id in the panel belongs to an old city. */
  clear(): void {
    this.dirty = true;
    this.selected = null;
    this.selectedStation = null;
    this.selectedLorry = null;
  }

  update(sim: Simulation, now = performance.now()): void {
    if (!this.dirty && now - this.lastDraw < REFRESH_MS) return;
    this.lastDraw = now;
    this.dirty = false;

    if (this.selectedLorry) {
      this.title = 'トラック';
      this.updateLorry(sim, this.selectedLorry);
      return;
    }
    if (this.selectedStation) {
      const b = this.selectedStation;
      this.title = BUILDING_LABELS[b.type];
      if (isTransitStop(b.type)) this.updateStation(sim, b);
      else this.updateBuilding(sim, b);
      return;
    }
    this.title = '市民';

    const c = this.selected;
    if (!c) {
      this.body.innerHTML = '<p class="empty">市民・建物・駅・トラックをクリック</p>';
      return;
    }

    const world = sim.world;
    const home = world.buildings[c.home];
    const work = c.work >= 0 ? world.buildings[c.work] : null;

    const rows: Array<[string, string]> = [
      ['名前', `${c.name} (${c.age}歳)`],
      ['状態', stateLabel(c)],
      ['幸福度', c.happiness < 0 ? '—' : `${Math.round(c.happiness)} / 100${moodNote(c)}`],
      ['学歴', `${Math.round(c.education)} / 100`],
      ['健康', `${Math.round(c.health)} / 100`],
      ['車', c.hasCar ? 'あり' : 'なし（徒歩か公共交通）'],
      ['自宅', home ? address(home.tile) : '—'],
      ['職場', work ? address(work.tile) : '未就業'],
      ['出勤', formatMinute(departForWorkMinute(c.seed))],
      ['退勤', formatMinute(departForHomeMinute(c.seed))],
      // The rest day is why somebody is at home on a weekday afternoon. The
      // clock counts days rather than naming weekdays, so this says when the
      // next one is in the same terms -- a 曜日 nothing else in the game
      // mentions would be a second calendar to keep in your head.
      ['休み', restDayLabel(sim.clock.day, c.seed)],
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
        const train = world.trains[c.boardedVehicle];
        if (train) {
          rows.push(['乗客数', `${train.passengers.length} / ${TRAIN_CAPACITY} 人`]);
        }
      }
    }

    if (c.path && isTravelling(c.state)) {
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
      this.body.append(...subheading('住環境'));
      this.body.appendChild(definitionList([
        ['騒音', `${Math.round(sim.noise.at(home.tile))} / 100`],
        ['治安', `${Math.round(100 - sim.crime.at(home.tile))} / 100`],
        ['電気', home.powered ? '来ている' : '来ていない'],
        ['学校', sim.services.serves(Service.School, home) ? '通える' : '通えない'],
        ['消防', sim.services.serves(Service.Fire, home) ? '間に合う' : '届かない'],
        ['病院', sim.services.serves(Service.Health, home) ? 'かかれる' : '届かない'],
        ['標高', heightLabel(sim, home.tile)],
        ['食料の備え', `${c.pantry.toFixed(1)} 日分${c.lastShopFailed ? '（前回買えず）' : ''}`],
        ['余暇の充実', `${c.leisure.toFixed(1)} 日分${c.lastOutingFailed ? '（前回入れず）' : ''}`],
      ]));
      this.appendLandValue(sim, home.tile);
    }
  }

  /**
   * What this tile's land value is made of.
   *
   * Land value is the one number in the game nobody sets: it is the sum of
   * every other decision the player has made, which makes it the number they
   * are most likely to want explained. Showing the terms turns "地価 62" into
   * "駅が近い、でも工場の騒音で目減りしている", which is something to act on.
   */
  private appendLandValue(sim: Simulation, tile: number): void {
    const f = sim.landValue.factorsAt(sim.world, sim.noise, sim.crime, tile, sim.policies);
    this.body.append(
      ...subheading(
        `地価 ${Math.round(f.current)} / 100 の内訳`,
        LAND_VALUE_HELP,
        this.helpState,
        'landValue',
      ),
    );
    this.body.appendChild(definitionList([
      ['基準値', `${f.base}`],
      ...LAND_VALUE_TERMS
        .map(([key, label]) => [label, signedPoints(f[key])] as [string, string])
        .filter(([, value]) => value !== '±0'),
      ['→ 落ち着く先', `${Math.round(f.target)}`],
    ]));
  }

  /**
   * One lorry: what it is carrying, where from, where to, and how it is
   * getting on. The same panel a citizen gets, because a delivery running
   * late for the same reason a commuter is late is the whole point of
   * putting the goods on the road.
   */
  private updateLorry(sim: Simulation, lorry: Lorry): void {
    const world = sim.world;
    const depot = world.buildings[lorry.home];
    const target = lorry.destination >= 0 ? world.buildings[lorry.destination] : undefined;
    const spec = lorry.profile;

    const rows: Array<[string, string]> = [
      ['状態', LORRY_STATE_LABELS[lorry.state]],
      ['積荷', `${lorry.cargo.toFixed(0)} / ${LORRY_CAPACITY} ${
        lorry.cargoKind === CargoKind.Raw ? '（原材料）' : '（商品）'}`],
      ['所属', depot && depot.alive ? `${BUILDING_LABELS[depot.type]} ${address(depot.tile)}` : '—'],
      ['行き先', target && target.alive
        ? `${BUILDING_LABELS[target.type]} ${address(target.tile)}`
        : '—'],
      ['本日の配送', `${lorry.trips} 件`],
    ];

    if (lorry.path) {
      const remaining = lorry.path.length - 1 - lorry.s;
      rows.push(['残り距離', `${Math.round(remaining)} タイル`]);
      rows.push(['速度', `${Math.round((lorry.v / spec.freeSpeed) * 100)}%${
        lorry.blockedTicks > 30 ? '（渋滞で停止中）' : ''}`]);
    }

    this.body.innerHTML = '';
    this.body.appendChild(definitionList(rows));
    if (lorry.path) this.body.appendChild(speedBar(lorry.v / spec.freeSpeed));
  }

  /**
   * Any building other than a station: what it employs, what it is powered by
   * and -- for anything in the supply chain -- what it has to work with. A
   * factory sitting idle should be able to say so itself.
   */
  private updateBuilding(sim: Simulation, b: Building): void {
    if (!sim.world.isAlive(b)) {
      this.body.innerHTML = '<p class="empty">撤去されました</p>';
      return;
    }
    const spec = specFor(b.type);
    const rows: Array<[string, string]> = [
      ['場所', address(b.tile)],
      [isHome(b.type) ? '居住者' : '従業員', `${b.occupants.length} / ${b.capacity} 人`],
      ['電気', b.powered ? `来ている（${spec.power}）` : '⚠ 来ていない'],
      ['騒音', `${Math.round(sim.noise.at(b.tile))} / 100`],
      ['治安', `${Math.round(100 - sim.crime.at(b.tile))} / 100`],
      ['標高', heightLabel(sim, b.tile)],
      ['消防', sim.services.serves(Service.Fire, b) ? '署から届く' : '⚠ 届かない'],
    ];

    // What the city's own buildings are for, said in the terms the panel for
    // the city uses -- a station keeps its passengers, a school its catchment.
    if (b.type === BuildingType.School) {
      rows.push(['市内で通える住宅', `${countServed(sim, Service.School)} 軒`]);
    } else if (b.type === BuildingType.FireStation) {
      rows.push(['市内で守れる住宅', `${countServed(sim, Service.Fire)} 軒`]);
      rows.push(['出動中', `${busyUnits(sim, b.id)} 台 / ${unitsOf(sim, b.id)} 台`]);
    } else if (b.type === BuildingType.PoliceStation) {
      rows.push(['付近の治安', `${Math.round(100 - sim.crime.at(b.tile))} / 100`]);
      rows.push(['出動中', `${busyUnits(sim, b.id)} 台 / ${unitsOf(sim, b.id)} 台`]);
    } else if (b.type === BuildingType.Hospital) {
      rows.push(['市内でかかれる住宅', `${sim.services.report.healthCovered} 軒`]);
      rows.push(['市内の平均健康', `${Math.round(sim.services.report.health)} / 100`]);
    } else if (isLeisure(b.type)) {
      const capacity = leisureCapacity(b.type) * LEISURE_VISITS_PER_CAPACITY;
      rows.push(['本日の来場', `${b.visitsToday} / ${capacity} 人`]);
      rows.push(['集客力', `${leisureDraw(b.type).toFixed(1)} 倍`]);
      rows.push(['人が来る距離の目安', `${Math.round(reach(sim.policies))} タイル`]);
      if (b.visitsToday >= capacity) rows.push(['状況', '⚠ 満員（今日はもう入れません）']);
    }

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
    // What the lorries are doing for this building. Without this, a player
    // looking at a factory whose stock left on a truck ten seconds ago would
    // think the goods had simply vanished.
    const inbound = sim.world.lorries.filter(
      (l) => l.destination === b.id && l.cargo > 0,
    ).reduce((n, l) => n + l.cargo, 0);
    const outbound = sim.world.lorries.filter((l) => l.home === b.id && l.cargo > 0);
    if (inbound > 0) rows.push(['入荷予定', `${Math.round(inbound)} 単位`]);
    if (outbound.length > 0) {
      rows.push(['出荷中', `${outbound.length} 台 ／ ${
        Math.round(outbound.reduce((n, l) => n + l.cargo, 0))} 単位`]);
    }

    if (b.starvedHours > 0) {
      rows.push(['稼働できない時間', `${b.starvedHours} 時間`]);
    }
    if (spec.upkeep > 0) {
      rows.push(['維持費', `¥${spec.upkeep.toLocaleString('ja-JP')} / 日`]);
    }

    this.body.innerHTML = '';

    // An incident outranks whatever else is wrong with the building: it has a
    // clock on it, and the rest does not.
    const incident = sim.emergency.incidentAt(b.id);
    if (incident) {
      const fire = incident.kind === IncidentKind.Fire;
      const left = Math.max(0, incident.deadlineTick - sim.clock.tick);
      const banner = document.createElement('p');
      banner.className = `warning warning-${fire ? 'critical' : 'warning'}`;
      banner.textContent = fire
        ? `火災発生中 — あと ${Math.round(ticksToMinutes(left))} 分で全焼`
        : `盗難発生中 — あと ${Math.round(ticksToMinutes(left))} 分`;
      const advice = help(
        fire
          ? '消防車が到着すれば消し止められます。間に合わなければ建物は失われます。'
            + '道路がつながっているか、消防署が遠すぎないかを確認してください。'
          : 'パトカーが到着すれば解決します。間に合わなければ商品が盗まれ、'
            + 'その一帯の治安がさらに悪化します。',
        this.helpState,
        fire ? 'fire' : 'crime',
      );
      banner.appendChild(advice.button);
      this.body.append(banner, advice.body);
    }

    const issue = buildingIssue(b);
    if (issue !== null) {
      const style = BUILDING_ISSUES[issue];
      const banner = document.createElement('p');
      banner.className = `warning warning-${style.tone}`;
      banner.textContent = `${style.icon} ${style.label}`;
      const advice = help(style.advice, this.helpState, `issue-${issue}`);
      banner.appendChild(advice.button);
      this.body.append(banner, advice.body);
    }
    this.body.appendChild(definitionList(rows));
    this.appendLandValue(sim, b.tile);
  }

  /**
   * A station: how many people are stood on the platform right now, and what
   * is coming to collect them. The waiting figure is the same counter the map
   * badge draws, so the panel and the badge can never disagree.
   */
  private updateStation(sim: Simulation, station: Building): void {
    const world = sim.world;
    if (!world.isAlive(station)) {
      this.body.innerHTML = '<p class="empty">撤去されました</p>';
      return;
    }

    const lines = world.activeLines.filter((l) => l.stations.includes(station.id));
    const rows: Array<[string, string]> = [
      ['場所', address(station.tile)],
      ['待ち人数', `${sim.stats.waitingAt(station.id)} 人`],
      ['乗り入れ', lines.length === 0 ? 'なし' : lines.map((l) => l.name).join('、')],
      ['電気', station.powered ? '来ている' : '⚠ 来ていない'],
      ['区画', ZONE_LABELS[world.map.getZone(station.tile)]],
    ];

    for (const line of lines) {
      const spec = lineSpec(line);
      rows.push([
        `${line.name} の${spec.label === 'バス' ? '車両' : '列車'}`,
        `${line.vehicles.length} 本 ／ 乗車 ${aboardOn(world, line)} 人`,
      ]);
      rows.push([`${line.name} のべ乗車`, `${line.ridership} 人`]);
    }

    this.body.innerHTML = '';
    this.body.appendChild(definitionList(rows));
  }
}

const BUILDING_LABELS: Record<BuildingType, string> = {
  [BuildingType.BusStop]: 'バス停',
  [BuildingType.School]: '学校',
  [BuildingType.FireStation]: '消防署',
  [BuildingType.PoliceStation]: '警察署',
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
  [BuildingType.Hospital]: '病院',
  [BuildingType.Park]: '公園',
  [BuildingType.Stadium]: '競技場',
  [BuildingType.AmusementPark]: '遊園地',
};

const LORRY_STATE_LABELS: Record<LorryState, string> = {
  [LorryState.Idle]: '待機中',
  [LorryState.Loading]: '積み込み中',
  [LorryState.Outbound]: '配送中',
  [LorryState.Unloading]: '荷降ろし中',
  [LorryState.Returning]: '帰庫中',
  [LorryState.Stuck]: '⚠ 経路なし',
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
    case CitizenState.ToShop:
      return '買い物へ向かっている';
    case CitizenState.AtShop:
      return '買い物中';
    case CitizenState.ToLeisure:
      return 'おでかけ中（施設へ）';
    case CitizenState.AtLeisure:
      return 'レジャー中';
    case CitizenState.Stranded:
      return '⚠ 経路なし（道路が繋がっていません）';
  }
}

/**
 * When this citizen's next day off is, counted in the days the clock shows.
 */
function restDayLabel(day: number, seed: number): string {
  if (isRestDay(seed, day)) return '今日';
  for (let ahead = 1; ahead <= REST_DAYS_PER_WEEK; ahead++) {
    if (isRestDay(seed, day + ahead)) {
      return ahead === 1 ? '明日' : `${ahead}日後（Day ${day + ahead + 1}）`;
    }
  }
  return '—';
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

/** The amenities the land value model adds up, in the order it applies them. */
const LAND_VALUE_TERMS: ReadonlyArray<[keyof LandValueFactors, string]> = [
  ['water', '水辺'],
  ['greenery', '森'],
  ['view', '眺望'],
  ['station', '駅が近い'],
  ['shops', '商店が近い'],
  ['offices', 'オフィスが近い'],
  ['parks', '公園・レジャー'],
  ['noise', '騒音'],
  ['crime', '治安'],
];

/** Amenities are shown as what they add or take away, not as a total. */
function signedPoints(value: number): string {
  const rounded = Math.round(value);
  if (rounded === 0) return '±0';
  return rounded > 0 ? `+${rounded}` : `${rounded}`;
}


/** A tile's height, and how it sits against the ground around it. */
function heightLabel(sim: Simulation, tile: number): string {
  const map = sim.world.map;
  const prominence = map.prominence[tile];
  const relief = map.relief(tile);
  const where = prominence >= 2 ? '（高台）' : prominence <= -2 ? '（窪地）' : '';
  return `${map.height[tile]} / ${MAX_TERRAIN_HEIGHT}${where}`
    + (relief >= 2 ? `　傾斜 ${relief}` : '');
}

/** Riders aboard every vehicle working a line right now. */
function aboardOn(world: World, line: TransitLine): number {
  let aboard = 0;
  for (const id of line.vehicles) {
    const vehicle = line.mode === LineMode.Rail
      ? world.trains[id]
      : world.buses[id - BUS_ID_BASE];
    aboard += vehicle?.passengers.length ?? 0;
  }
  return aboard;
}

/**
 * Homes this kind of service reaches, city-wide.
 *
 * Deliberately not per-station: coverage is a union over every station of that
 * kind, so "how many homes does *this* school serve" has no answer that two
 * overlapping catchments would agree on. The row says 市内 for that reason.
 */
function countServed(sim: Simulation, service: Service): number {
  const report = sim.services.report;
  return service === Service.School ? report.schooled : report.fireCovered;
}

function unitsOf(sim: Simulation, station: number): number {
  return sim.world.units.filter((u) => u.home === station).length;
}

function busyUnits(sim: Simulation, station: number): number {
  return sim.world.units.filter((u) => u.home === station && u.path !== null).length;
}
