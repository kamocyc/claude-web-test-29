import {
  ORDINANCE_ENERGY_COST_PER_BUILDING,
  ORDINANCE_ENERGY_SAVING,
  ORDINANCE_GREENING_COST_PER_PARK,
  ORDINANCE_HEALTH_BONUS,
  ORDINANCE_HEALTH_COST_PER_RESIDENT,
  ORDINANCE_PATROL_COST_PER_RESIDENT,
  ORDINANCE_PATROL_RELIEF,
  ORDINANCE_TRANSIT_COST_PER_RIDER,
  ORDINANCE_TRANSIT_PREFERENCE,
  TRANSIT_PREFERENCE,
} from '../config';
import { BuildingType } from '../core/types';
import { isLeisure } from '../world/buildings';
import type { World } from '../world/world';

/**
 * The city's by-laws: a switch, a daily bill, and one number changed somewhere
 * the player can already see.
 *
 * Every ordinance here is a multiplier on a system that already exists rather
 * than a mechanism of its own -- the fare subsidy moves the threshold the mode
 * choice is already measured against, the energy by-law scales the draw the
 * grid already sums, the patrols add to the relief a police station already
 * spreads. That constraint is what keeps them honest: an ordinance can only do
 * something the player could have watched happen anyway, and its effect shows
 * up in the panel that was already showing that number.
 *
 * The bills are deliberately *proportional to the city* rather than flat. A
 * flat fee is free for a large city and ruinous for a small one, so every
 * ordinance would be a question answered once at the start of the game; billed
 * per rider, per building or per resident, keeping one on stays a decision as
 * the city grows.
 */
export const enum Ordinance {
  /** 運賃補助: riders put up with more to leave the car at home. */
  TransitSubsidy = 0,
  /** 省エネ条例: every building draws less. */
  EnergySaving = 1,
  /** 夜間パトロール: more relief around every working police station. */
  NightPatrol = 2,
  /** 緑化条例: parks are worth more, and pull further. */
  Greening = 3,
  /** 無料健診: health settles higher wherever a hospital reaches. */
  FreeClinics = 4,
}

export interface OrdinanceSpec {
  name: string;
  /** What it does, in one sentence, for the panel. */
  effect: string;
  /** How the bill is worked out, for the panel to say so honestly. */
  billing: string;
}

export const ORDINANCES: Record<Ordinance, OrdinanceSpec> = {
  [Ordinance.TransitSubsidy]: {
    name: '運賃補助',
    effect: '公共交通が多少遅くても選ばれるようになります（自動車から転移）。',
    billing: '前日の乗車人数に比例',
  },
  [Ordinance.EnergySaving]: {
    name: '省エネ条例',
    effect: 'すべての建物の消費電力が15%減ります。',
    billing: '建物の数に比例',
  },
  [Ordinance.NightPatrol]: {
    name: '夜間パトロール',
    effect: '稼働中の警察署のまわりの治安がさらに良くなります。',
    billing: '人口に比例',
  },
  [Ordinance.Greening]: {
    name: '緑化条例',
    effect: '公園・レジャー施設の地価への効果と集客力が上がります。',
    billing: '公園・レジャー施設の数に比例',
  },
  [Ordinance.FreeClinics]: {
    name: '無料健診',
    effect: '病院のとどく範囲の住民の健康が上がります。',
    billing: '人口に比例',
  },
};

/** Every ordinance, in the order the panel lists them. */
export const ALL_ORDINANCES: readonly Ordinance[] = [
  Ordinance.TransitSubsidy,
  Ordinance.EnergySaving,
  Ordinance.NightPatrol,
  Ordinance.Greening,
  Ordinance.FreeClinics,
];

export class Policies {
  private readonly on = new Set<Ordinance>();

  /** Yesterday's bill per ordinance, so the panel can show what each cost. */
  lastBill = new Map<Ordinance, number>();

  isOn(ordinance: Ordinance): boolean {
    return this.on.has(ordinance);
  }

  toggle(ordinance: Ordinance): boolean {
    if (this.on.has(ordinance)) this.on.delete(ordinance);
    else this.on.add(ordinance);
    return this.isOn(ordinance);
  }

  set(ordinance: Ordinance, enabled: boolean): void {
    if (enabled) this.on.add(ordinance);
    else this.on.delete(ordinance);
  }

  get enabled(): Ordinance[] {
    return ALL_ORDINANCES.filter((o) => this.on.has(o));
  }

  // --- The effects ---------------------------------------------------------
  // Each one is asked for by the system it belongs to, rather than pushed into
  // it: the planner asks what riders will put up with, the grid asks what a
  // building draws. Nothing here writes to the world.

  /** The threshold transit has to beat to win somebody over. */
  get transitPreference(): number {
    return TRANSIT_PREFERENCE
      * (this.isOn(Ordinance.TransitSubsidy) ? ORDINANCE_TRANSIT_PREFERENCE : 1);
  }

  /** What a building actually draws, given its rated demand. */
  powerDraw(rated: number): number {
    return this.isOn(Ordinance.EnergySaving)
      ? rated * (1 - ORDINANCE_ENERGY_SAVING)
      : rated;
  }

  /** Extra crime relief around a working police station. */
  get patrolRelief(): number {
    return this.isOn(Ordinance.NightPatrol) ? ORDINANCE_PATROL_RELIEF : 0;
  }

  /** What a hospital's catchment is worth on top of the usual. */
  get healthBonus(): number {
    return this.isOn(Ordinance.FreeClinics) ? ORDINANCE_HEALTH_BONUS : 0;
  }

  /**
   * Yesterday's total bill, and the per-ordinance breakdown that goes with it.
   *
   * Charged in `Economy.settleDay` along with the upkeep, because that is what
   * it is: a standing cost the city pays whether or not it can, which is
   * exactly the pressure the overdraft exists to apply.
   */
  settleDay(world: World, ridersYesterday: number): number {
    this.lastBill = new Map();
    let total = 0;
    for (const ordinance of this.enabled) {
      const cost = this.costOf(ordinance, world, ridersYesterday);
      this.lastBill.set(ordinance, cost);
      total += cost;
    }
    return total;
  }

  /** What one ordinance would cost the city today, whether or not it is on. */
  costOf(ordinance: Ordinance, world: World, ridersYesterday = 0): number {
    switch (ordinance) {
      case Ordinance.TransitSubsidy:
        return ridersYesterday * ORDINANCE_TRANSIT_COST_PER_RIDER;
      case Ordinance.EnergySaving:
        return countLiveBuildings(world) * ORDINANCE_ENERGY_COST_PER_BUILDING;
      case Ordinance.NightPatrol:
        return world.population * ORDINANCE_PATROL_COST_PER_RESIDENT;
      case Ordinance.Greening:
        return countParks(world) * ORDINANCE_GREENING_COST_PER_PARK;
      case Ordinance.FreeClinics:
        return world.population * ORDINANCE_HEALTH_COST_PER_RESIDENT;
    }
  }

  /** Restored from a save. */
  restore(enabled: readonly number[]): void {
    this.on.clear();
    for (const o of enabled) {
      if (ALL_ORDINANCES.includes(o as Ordinance)) this.on.add(o as Ordinance);
    }
  }

  snapshot(): number[] {
    return this.enabled.slice();
  }
}

function countLiveBuildings(world: World): number {
  let n = 0;
  for (const b of world.buildings) {
    if (b.alive && b.type !== BuildingType.Park) n++;
  }
  return n;
}

function countParks(world: World): number {
  let n = 0;
  for (const b of world.buildings) {
    if (b.alive && isLeisure(b.type)) n++;
  }
  return n;
}
