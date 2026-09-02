import {
  GOODS_PER_RESIDENT_PER_DAY,
  SHOPPING_BASKET,
  SHOP_CANDIDATES,
  SHOP_HEADROOM,
  SHOP_SEARCH_RADIUS,
} from '../config';
import { manhattan } from '../core/grid';
import { BuildingType, type BuildingId } from '../core/types';
import { operatingRatio, type Building } from '../world/buildings';
import type { World } from '../world/world';
import type { Citizen } from './citizen';

/**
 * The last leg of the supply chain: somebody goes to the shops.
 *
 * Consumption used to be arithmetic -- an hourly figure spread across the
 * shops in proportion to their stock -- which meant the city's goods were
 * consumed by the population rather than by any particular person. A shop
 * with an empty shelf was a number in a report; nobody walked to it and found
 * it bare, and nobody's evening was spent driving across town because the
 * nearest one had nothing.
 *
 * Now every unit sold is somebody's trip. Which makes the trip itself part of
 * the city: shopping traffic uses the same roads at a different time of day
 * from the commute, and a shop is worth siting near the housing for exactly
 * the reason a station is.
 */

/** Groceries used per sim hour by one resident. */
export const PANTRY_DRAIN_PER_HOUR = GOODS_PER_RESIDENT_PER_DAY / 24;

/**
 * Where this citizen would go to shop, or -1.
 *
 * Nearest first, but only shops with enough on the shelf to be worth the
 * journey. That filter is what stops a stampede: without it the whole
 * neighbourhood walks to the same nearest shop, empties it, and comes home
 * with nothing -- and then all of them are out of food on the same evening
 * again tomorrow.
 */
export function chooseShop(world: World, c: Citizen): BuildingId {
  const home = world.buildings[c.home];
  if (!home || !home.alive) return -1;

  const candidates: Array<{ shop: Building; d: number }> = [];
  for (const b of world.buildings) {
    if (!b.alive || b.type !== BuildingType.Shop) continue;
    const d = manhattan(b.tile, home.tile);
    if (d > SHOP_SEARCH_RADIUS) continue;
    candidates.push({ shop: b, d });
  }
  candidates.sort((a, b) => (a.d - b.d) || (a.shop.id - b.shop.id));

  let fallback = -1;
  let considered = 0;
  for (const { shop } of candidates) {
    if (operatingRatio(shop) <= 0 || shop.goodsStock <= 0) continue;
    if (fallback < 0) fallback = shop.id;
    if (++considered > SHOP_CANDIDATES) break;
    if (shop.goodsStock >= SHOPPING_BASKET * SHOP_HEADROOM) return shop.id;
  }
  // Nothing with anything on the shelf: stay at home hungry rather than walk
  // to a shop that is visibly empty. A wasted trip is a real outcome -- the
  // shelf can be cleared between setting out and arriving, which happens
  // every evening -- but a city where nothing is for sale anywhere should
  // show up as hunger, not as everybody driving around all day.
  return fallback;
}

/**
 * Fill the basket. Returns what was actually bought, which is often less than
 * was wanted and sometimes nothing at all.
 */
export function buy(shop: Building, c: Citizen): number {
  const wanted = Math.max(0, SHOPPING_BASKET - c.pantry);
  const bought = Math.min(wanted, shop.goodsStock);
  if (bought <= 0) {
    c.lastShopFailed = true;
    return 0;
  }
  shop.goodsStock -= bought;
  shop.soldToday += bought;
  c.pantry += bought;
  c.lastShopFailed = false;
  return bought;
}

/**
 * How well fed this citizen is, 0..1, for the happiness panel.
 *
 * A cupboard with a day left is fine; one that ran out is not, and a wasted
 * trip counts against the city even if the cupboard is not empty yet.
 */
export function shoppingSatisfaction(c: Citizen): number {
  const stocked = Math.min(1, c.pantry / SHOPPING_BASKET);
  return c.lastShopFailed ? stocked * 0.5 : stocked;
}
