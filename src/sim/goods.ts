import { GOODS_PER_RESIDENT_PER_DAY } from '../config';
import { Industry } from '../core/types';
import { industryOf, operatingRatio, specFor, type Building } from '../world/buildings';
import type { World } from '../world/world';

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

  /** One sim-hour of production and conversion. */
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

    // 3. Residents buy. A shop with nothing on the shelves earns nothing, and
    //    that is what the commercial tax is levied on.
    const wanted = (world.population * GOODS_PER_RESIDENT_PER_DAY) / 24;
    let remaining = wanted;
    // Water-filling: each shop serves its share of what is *left*, so a shop
    // that has run out does not silently cost the city that share. Dividing by
    // the original count instead leaves about a third of the demand unserved
    // even when the warehouses are full, which reads as a broken chain when
    // nothing is actually wrong.
    const open = shops.filter((b) => operatingRatio(b) > 0);
    for (let i = 0; i < open.length; i++) {
      const b = open[i];
      const share = Math.min(b.goodsStock, remaining / (open.length - i));
      b.goodsStock -= share;
      b.soldToday += share;
      remaining -= share;
      report.goodsSold += share;
      track(b, share > 0);
    }
    for (const b of shops) {
      if (b.goodsStock <= 0) report.shopsEmpty++;
    }

    this.report = report;
  }

  /** How much of what residents wanted to buy the shops could actually serve. */
  serviceLevel(world: World): number {
    const wanted = (world.population * GOODS_PER_RESIDENT_PER_DAY) / 24;
    if (wanted <= 0) return 1;
    return Math.min(1, this.report.goodsSold / wanted);
  }
}

/** Count the hours a building spends unable to do its job. */
function track(b: Building, working: boolean): void {
  b.starvedHours = working ? 0 : b.starvedHours + 1;
}
