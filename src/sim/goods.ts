import { Industry } from '../core/types';
import { industryOf, operatingRatio, specFor, type Building } from '../world/buildings';
import type { World } from '../world/world';
import { PANTRY_DRAIN_PER_HOUR } from './shopping';

export interface ChainReport {
  rawProduced: number;
  goodsProduced: number;
  goodsSold: number;
  /** Shops that could not serve, and factories that could not run. */
  shopsEmpty: number;
  factoriesIdle: number;
}

/**
 * The production half of the supply chain: primary industry digs and grows,
 * factories convert.
 *
 * Moving the goods is not here any more. It used to be -- a consumer reached
 * out to the nearest supplier on the same road network and the units simply
 * appeared -- and that produced the right totals while quietly making the road
 * network irrelevant to the economy it was supposedly carrying. Transport is
 * now `freight.ts`, where every load is a lorry that has to drive there.
 *
 * What is left runs once per sim hour, because production is a rate and
 * nothing here needs to be finer than that.
 */
export class SupplyChain {
  report: ChainReport = {
    rawProduced: 0,
    goodsProduced: 0,
    goodsSold: 0,
    shopsEmpty: 0,
    factoriesIdle: 0,
  };

  private soldSinceLastStep = 0;

  /** One sim-hour of production, conversion and consumption. */
  step(world: World): void {
    const report: ChainReport = {
      rawProduced: 0,
      goodsProduced: 0,
      goodsSold: 0,
      shopsEmpty: 0,
      factoriesIdle: 0,
    };

    const primaries: Building[] = [];
    const factories: Building[] = [];
    const shops: Building[] = [];

    for (const b of world.buildings) {
      if (!b.alive) continue;
      switch (industryOf(b.type)) {
        case Industry.Primary:
          primaries.push(b);
          break;
        case Industry.Secondary:
          factories.push(b);
          break;
        case Industry.Retail:
          shops.push(b);
          break;
        default:
          break;
      }
    }

    // 1. Primary industry makes raw materials out of the ground.
    for (const b of primaries) {
      const spec = specFor(b.type);
      const made = spec.outputPerHour * operatingRatio(b);
      b.goodsStock = Math.min(spec.storage, b.goodsStock + made);
      report.rawProduced += made;
      track(b, made > 0);
    }

    // 2. Factories work through whatever the lorries have brought them.
    for (const b of factories) {
      const spec = specFor(b.type);
      const ratio = operatingRatio(b);
      const possible = Math.min(spec.outputPerHour * ratio, b.rawStock);
      if (possible > 0) {
        b.rawStock -= possible;
        b.goodsStock = Math.min(spec.storage, b.goodsStock + possible);
        report.goodsProduced += possible;
      }
      if (possible <= 0 && ratio > 0) report.factoriesIdle++;
      track(b, possible > 0 || ratio === 0);
    }

    // 3. The shops: what they sold is what shoppers actually carried out of
    //    them over the past hour, not a share of an abstract total.
    report.goodsSold = this.soldSinceLastStep;
    this.soldSinceLastStep = 0;
    for (const b of shops) {
      if (b.goodsStock <= 0) report.shopsEmpty++;
      // A shop with stock is doing its job even in a quiet hour; only an
      // empty one is failing, and only that should get it closed down.
      track(b, b.goodsStock > 0 || operatingRatio(b) === 0);
    }

    // 4. Every household eats.
    for (const c of world.citizens) {
      c.pantry = Math.max(0, c.pantry - PANTRY_DRAIN_PER_HOUR);
    }

    this.report = report;
  }

  /** Called by a citizen walking out of a shop with their shopping. */
  recordSale(units: number): void {
    this.soldSinceLastStep += units;
  }

  /**
   * How well the city is fed, as the share of households with something in
   * the cupboard.
   *
   * A stock rather than a flow. Measuring the hour's sales against the hour's
   * demand looked reasonable while consumption was a smooth abstraction, but
   * real shopping trips are lumpy -- everybody buys three days at once, in
   * the evening -- so an hourly ratio would swing between nothing and
   * everything for a city that was perfectly well supplied. What the question
   * is actually asking is whether people can buy things, and the cupboards
   * answer it.
   */
  serviceLevel(world: World): number {
    if (world.citizens.length === 0) return 1;
    let fed = 0;
    for (const c of world.citizens) {
      if (c.pantry > 0) fed++;
    }
    return fed / world.citizens.length;
  }
}

/** Count the hours a building spends unable to do its job. */
function track(b: Building, working: boolean): void {
  b.starvedHours = working ? 0 : b.starvedHours + 1;
}
