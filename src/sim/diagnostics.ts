import { BuildingType, CitizenState, Industry, type TileIndex } from '../core/types';
import { industryOf, isHome, isWorkplace, type Building } from '../world/buildings';
import { IncidentKind } from './emergency';
import { leisureReport } from './leisure';
import type { Simulation } from './simulation';

/**
 * What is wrong with the city, in one place.
 *
 * The map and the panels used to disagree about this: the toolbar had its own
 * hand-written list of complaints, the inspector had another, and a building
 * that was failing looked exactly like one that was fine until you clicked on
 * it. Both now read from here, so the icon floating over a shop and the line
 * in the warnings window are the same finding rather than two descriptions of
 * it that can drift apart.
 */

/** What is wrong with one building. Ordered by how badly it stops it working. */
export const enum BuildingIssue {
  /** No electricity: the building does nothing at all. */
  NoPower = 0,
  /** A shop with empty shelves, or a factory with no raw materials. */
  NoSupply = 1,
  /** Nobody works here, so nothing is produced. */
  NoStaff = 2,
}

export interface IssueStyle {
  /** One glyph, drawn in the badge over the building. */
  icon: string;
  label: string;
  /** What the player should do about it. */
  advice: string;
  /** Key into the palette, so the map and the panels colour it the same. */
  tone: 'critical' | 'warning' | 'info';
}

export const BUILDING_ISSUES: Record<BuildingIssue, IssueStyle> = {
  [BuildingIssue.NoPower]: {
    icon: '⚡',
    label: '電気が来ていない',
    advice: '発電所を建てるか、道路でこの建物を電力網につないでください。',
    tone: 'critical',
  },
  [BuildingIssue.NoSupply]: {
    icon: '空',
    label: '品切れ・原料切れ',
    advice: '商店には工場から商品を、工場には一次産業から原材料を運ぶ道路が必要です。',
    tone: 'warning',
  },
  [BuildingIssue.NoStaff]: {
    icon: '人',
    label: '働き手がいない',
    advice: '住宅を増やすか、住宅からここまでの通勤経路を短くしてください。',
    tone: 'info',
  },
};

/**
 * The one thing most worth saying about a building, or null when it is fine.
 *
 * One issue rather than all of them, because these are drawn on the map: a
 * dark factory is also out of materials and also unstaffed, and three badges
 * stacked over one tile say nothing that the first one did not.
 */
export function buildingIssue(b: Building): BuildingIssue | null {
  if (!b.alive) return null;
  if (b.type === BuildingType.Station || b.type === BuildingType.PowerPlant) {
    // Utilities are not judged on staff or stock; a dark station is still
    // worth flagging, since it stops serving trains.
    return b.powered ? null : BuildingIssue.NoPower;
  }
  if (!b.powered) return BuildingIssue.NoPower;

  const industry = industryOf(b.type);
  if (industry === Industry.Retail && b.goodsStock < 1) return BuildingIssue.NoSupply;
  if (industry === Industry.Secondary && b.rawStock < 1) return BuildingIssue.NoSupply;
  if (isWorkplace(b.type) && b.occupants.length === 0) return BuildingIssue.NoStaff;
  return null;
}

/** How urgent a city-wide warning is; also which colour it is drawn in. */
export type Severity = 'critical' | 'warning' | 'info';

export interface CityWarning {
  id: string;
  severity: Severity;
  icon: string;
  /** One line, as it appears in the toolbar ticker. */
  title: string;
  /** What to do about it. */
  advice: string;
  /** How many things are affected, or 0 when the warning is not a count. */
  count: number;
  /** Somewhere on the map worth looking at, or -1. */
  focus: TileIndex;
}

/**
 * Everything wrong with the city, worst first.
 *
 * The order is what the player has to fix first rather than what is largest:
 * a bankrupt city cannot fix anything else, and an unpowered building does not
 * work at all, so both come before complaints about the supply chain.
 */
export function cityWarnings(sim: Simulation): CityWarning[] {
  const warnings: CityWarning[] = [];
  const world = sim.world;
  const power = sim.power.report;
  const chain = sim.chain.report;
  const freight = sim.freight.report;

  if (sim.economy.inOverdraft) {
    warnings.push({
      id: 'money',
      severity: 'critical',
      icon: '¥',
      title: '資金がマイナスです',
      advice: '税率を上げるか、維持費のかかる施設を減らすか、借入してください。',
      count: 0,
      focus: -1,
    });
  }

  // A fire has a clock on it, so it outranks everything except insolvency:
  // by the time the player has finished reading the rest of the list the
  // building is gone.
  const emergency = sim.emergency.report;
  if (emergency.fires > 0) {
    warnings.push({
      id: 'fire',
      severity: 'critical',
      icon: '火',
      title: `${emergency.fires}件の火災が発生しています`,
      advice: emergency.unanswered > 0
        ? '消防車が向かっていません。消防署を建てるか、現場まで道路をつないでください。'
        : '消防車が向かっています。到着が間に合わないなら、'
          + '消防署をその地区に増やすか、途中の渋滞を解消してください。',
      count: emergency.fires,
      focus: firstIncidentTile(sim, IncidentKind.Fire),
    });
  }

  if (power.shortfall > 0) {
    warnings.push({
      id: 'powerShortfall',
      severity: 'critical',
      icon: '⚡',
      title: `電力が ${Math.round(power.shortfall)} 不足しています`,
      advice: '発電所を建ててください。電力は道路網ごとに独立しているので、'
        + '余っている地区とつながっていない地区は別に発電所が要ります。',
      count: Math.round(power.shortfall),
      focus: firstTileWith(sim, (b) => !b.powered),
    });
  }

  if (power.offGrid > 0) {
    warnings.push({
      id: 'offGrid',
      severity: 'critical',
      icon: '⚡',
      title: `${power.offGrid}件の建物が電力網から切れています`,
      advice: '電線は道路の下を通ります。道路でつないでください。',
      count: power.offGrid,
      focus: firstTileWith(sim, (b) => !b.powered),
    });
  }

  if (freight.stuck > 0) {
    warnings.push({
      id: 'lorriesStuck',
      severity: 'warning',
      icon: '🚚',
      title: `${freight.stuck}台のトラックが立ち往生しています`,
      advice: '配送先までの道路がつながっていません。途切れた道路をつないでください。',
      count: freight.stuck,
      focus: -1,
    });
  }

  if (chain.shopsEmpty > 0) {
    warnings.push({
      id: 'shopsEmpty',
      severity: 'warning',
      icon: '空',
      title: `${chain.shopsEmpty}軒の商店に売る商品がありません`,
      advice: '工場を商店の近くに置くか、工場までの道路の渋滞を解消してください。',
      count: chain.shopsEmpty,
      focus: firstTileWith(
        sim,
        (b) => industryOf(b.type) === Industry.Retail && b.goodsStock < 1,
      ),
    });
  }

  if (chain.factoriesIdle > 0) {
    warnings.push({
      id: 'factoriesIdle',
      severity: 'warning',
      icon: '原',
      title: `${chain.factoriesIdle}軒の工場に原材料がありません`,
      advice: '農業・林業・漁業・鉱業の区画を増やし、工場まで道路でつないでください。',
      count: chain.factoriesIdle,
      focus: firstTileWith(
        sim,
        (b) => industryOf(b.type) === Industry.Secondary && b.rawStock < 1,
      ),
    });
  }

  if (freight.unmetDemand > 100) {
    warnings.push({
      id: 'unmetDemand',
      severity: 'warning',
      icon: '🚚',
      title: '配送が需要に追いついていません',
      advice: '工業を商店の近くに置くか、道路の渋滞を解消してください。',
      count: Math.round(freight.unmetDemand),
      focus: -1,
    });
  }

  if (sim.strandedCount > 0) {
    warnings.push({
      id: 'stranded',
      severity: 'warning',
      icon: '⚑',
      title: `${sim.strandedCount}人が職場・自宅にたどり着けません`,
      advice: '住宅と職場をつなぐ道路が途切れています。',
      count: sim.strandedCount,
      focus: strandedTile(sim),
    });
  }

  const services = sim.services.report;
  if (services.fireStations === 0 && world.buildings.some((b) => b.alive && isHome(b.type))) {
    warnings.push({
      id: 'noFireStation',
      severity: 'warning',
      icon: '火',
      title: '消防署がありません',
      advice: '火災は誰も消しに来なければ建物ごと失われます。'
        + '消防署は道路をたどって届く範囲だけを守れるので、地区ごとに必要です。',
      count: 0,
      focus: -1,
    });
  }

  if (emergency.buildingsLostToday > 0) {
    warnings.push({
      id: 'burned',
      severity: 'warning',
      icon: '火',
      title: `本日 ${emergency.buildingsLostToday} 件の建物が焼失しました`,
      advice: '消防署をその地区の近くに建ててください。到着時間は道路と渋滞そのものです。',
      count: emergency.buildingsLostToday,
      focus: -1,
    });
  }

  const crime = sim.crime.meanResidential(world);
  if (crime > 45) {
    warnings.push({
      id: 'crime',
      severity: 'warning',
      icon: '盗',
      title: `住宅地の治安が悪化しています（犯罪度 ${Math.round(crime)}）`,
      advice: '警察署を建てるか、地価を上げてください。'
        + '犯罪は地価を下げ、下がった地価がさらに犯罪を呼びます。',
      count: Math.round(crime),
      focus: -1,
    });
  }

  if (services.homes > 0 && services.schooled < services.homes * 0.5) {
    warnings.push({
      id: 'noSchool',
      severity: 'info',
      icon: '学',
      title: `${services.homes - services.schooled}軒の住宅が学校に通えません`,
      advice: '学校を建てると学歴が上がり、同じ仕事でも生まれる賃金と税収が増えます。',
      count: services.homes - services.schooled,
      focus: -1,
    });
  }

  if (services.homes > 0 && services.hospitals === 0) {
    warnings.push({
      id: 'noHospital',
      severity: 'info',
      icon: '医',
      title: '病院がありません',
      advice: '病院が届かない地区は住民の健康が下がり、幸福度と地価に効いてきます。'
        + '学校や消防と同じで、道路をたどって届く範囲だけが対象です。',
      count: 0,
      focus: -1,
    });
  }

  // Leisure is judged on whether people actually got out, not on how many
  // parks exist: a city with a fairground nobody can reach is the case this
  // warning is for, and a building count would call that city well provided.
  const leisure = leisureReport(world);
  if (world.population >= 40 && leisure.satisfaction < 35) {
    warnings.push({
      id: 'noLeisure',
      severity: 'info',
      icon: '園',
      title: leisure.parks + leisure.venues === 0
        ? '公園やレジャー施設がありません'
        : '住民が出かけられていません',
      advice: leisure.parks + leisure.venues === 0
        ? '公園は最も安い公共施設で、まわりの地価をいちばん強く上げます。'
        : '施設が遠すぎるか、満員か、道路がつながっていません。'
          + '公園を住宅地の中に増やすと、いちばん確実に効きます。',
      count: 0,
      focus: -1,
    });
  }

  const movedOut = sim.happiness.lastMigration.movedOut;
  if (movedOut > 0) {
    warnings.push({
      id: 'movedOut',
      severity: 'info',
      icon: '↗',
      title: `${movedOut}人が街を出ていきました`,
      advice: '幸福度のうち一番低い項目を見てください。'
        + '通勤・住環境・食料・電気のどれかが原因です。',
      count: movedOut,
      focus: -1,
    });
  }

  const vacantJobs = world.jobCount - world.employedCount;
  if (world.population > 0 && vacantJobs > world.population * 0.5) {
    warnings.push({
      id: 'noWorkers',
      severity: 'info',
      icon: '人',
      title: `${vacantJobs}件の求人が埋まっていません`,
      advice: '住宅の区画を増やすか、職場までの通勤時間を短くしてください。',
      count: vacantJobs,
      focus: -1,
    });
  }

  return warnings;
}

/** Where the oldest incident of this kind is, so the player can go and look. */
function firstIncidentTile(sim: Simulation, kind: IncidentKind): TileIndex {
  for (const incident of sim.emergency.active) {
    if (incident.kind === kind) return incident.tile;
  }
  return -1;
}

/** The tile of the first live building matching `test`, or -1. */
function firstTileWith(sim: Simulation, test: (b: Building) => boolean): TileIndex {
  for (const b of sim.world.buildings) {
    if (b.alive && test(b)) return b.tile;
  }
  return -1;
}

/** Where somebody is standing having given up, so the player can go and look. */
function strandedTile(sim: Simulation): TileIndex {
  for (const c of sim.world.citizens) {
    if (c.state === CitizenState.Stranded) {
      return sim.world.map.at(Math.floor(c.x), Math.floor(c.y));
    }
  }
  return -1;
}
