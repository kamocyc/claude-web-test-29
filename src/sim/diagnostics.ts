import { BuildingType, CitizenState, Industry, type TileIndex } from '../core/types';
import { industryOf, isWorkplace, type Building } from '../world/buildings';
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
