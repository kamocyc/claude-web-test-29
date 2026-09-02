import { GOODS_PER_RESIDENT_PER_DAY, SUPPLY_RANGE_TILES } from '../config';
import { manhattan } from '../core/grid';
import { Industry } from '../core/types';
import { industryOf, operatingRatio, specFor, type Building } from '../world/buildings';
import type { PowerGrid } from './power';
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
 * The supply chain: primary industry -> factories -> shops -> residents.
 *
 * Run once per sim hour, on stockpiles rather than on vehicles. Freight agents
 * would be the honest thing and are the obvious next step, but they are also a
 * second traffic model on top of the one that already exists, and the decisions
 * the chain is here to create -- zone the whole chain, and *connect* it -- are
 * already forced by the one rule below: goods only move between buildings on
 * the same road network. A quarry with no road to the factories is as useless
 * as no quarry at all, which is the thing worth showing.
 *
 * Distance is not free either. Each consumer draws from the nearest supplier
 * with stock, and only out to SUPPLY_RANGE_TILES, so a city that puts its
 * industry on the far side of the map starves its shops just as surely.
 */
export class SupplyChain {
  report: ChainReport = {
    rawProduced: 0,
    goodsProduced: 0,
    goodsSold: 0,
    shopsEmpty: 0,
    factoriesIdle: 0,
  };

  /** One sim-hour of production, transport and sales. */
  step(world: World, power: PowerGrid): void {
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

    // 2. Factories pull raw materials in and turn them into goods.
    for (const b of factories) {
      const spec = specFor(b.type);
      const ratio = operatingRatio(b);
      const wanted = Math.min(spec.rawPerHour * ratio, spec.storage - b.rawStock);
      if (wanted > 0) b.rawStock += draw(world, power, b, primaries, wanted);

      const possible = Math.min(spec.outputPerHour * ratio, b.rawStock);
      if (possible > 0) {
        b.rawStock -= possible;
        b.goodsStock = Math.min(spec.storage, b.goodsStock + possible);
        report.goodsProduced += possible;
      }
      if (possible <= 0 && ratio > 0) report.factoriesIdle++;
      track(b, possible > 0 || ratio === 0);
    }

    // 3. Shops restock from the factories.
    for (const b of shops) {
      const spec = specFor(b.type);
      const room = spec.storage - b.goodsStock;
      if (room > 0) b.goodsStock += draw(world, power, b, factories, room * 0.5);
    }

    // 4. Residents buy. A shop with nothing on the shelves earns nothing, and
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

/**
 * Take up to `amount` from the nearest suppliers on the same road network.
 *
 * Nearest-first is what makes siting matter: a factory next to the paddies
 * gets fed before one across town, so a district laid out in the order of the
 * chain works better than one where everything is scattered.
 */
function draw(
  world: World,
  power: PowerGrid,
  consumer: Building,
  suppliers: Building[],
  amount: number,
): number {
  if (amount <= 0) return 0;
  world.refreshAccess(consumer);
  const grid = power.gridAt(consumer.accessRoad);
  if (grid < 0) return 0;

  const reachable: Array<{ b: Building; d: number }> = [];
  for (const s of suppliers) {
    if (s.goodsStock <= 0) continue;
    world.refreshAccess(s);
    if (power.gridAt(s.accessRoad) !== grid) continue;
    const d = manhattan(s.tile, consumer.tile);
    if (d > SUPPLY_RANGE_TILES) continue;
    reachable.push({ b: s, d });
  }
  reachable.sort((a, b) => a.d - b.d);

  let taken = 0;
  for (const { b } of reachable) {
    if (taken >= amount) break;
    const got = Math.min(b.goodsStock, amount - taken);
    b.goodsStock -= got;
    taken += got;
  }
  return taken;
}

/** Count the hours a building spends unable to do its job. */
function track(b: Building, working: boolean): void {
  b.starvedHours = working ? 0 : b.starvedHours + 1;
}
