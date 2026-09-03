import {
  FREIGHT_ABANDON_TICKS,
  GOODS_PER_RESIDENT_PER_DAY,
  FREIGHT_DISPATCHES_PER_ROUND,
  FREIGHT_MIN_LOAD,
  FREIGHT_RETRY_TICKS,
  FREIGHT_SUPPLIER_CANDIDATES,
  FREIGHT_TARGET_FILL,
  LORRIES_PER_BUILDING,
  LORRY_CAPACITY,
  LORRY_DWELL_TICKS,
  MAX_DELIVERY_TICKS,
  MAX_LORRIES,
} from '../config';
import { manhattan } from '../core/grid';
import { Industry, type BuildingId, type TileIndex } from '../core/types';
import { industryOf, operatingRatio, specFor, type Building } from '../world/buildings';
import type { World } from '../world/world';
import { tileCenterX, tileCenterY } from './citizen';
import { CargoKind, createLorry, isSpare, LorryState, type Lorry } from './lorry';
import { advanceVehicle, pathIsBroken, routeToBuilding, setPositionFromPath } from './movement';
import { findPath, type PathCache } from './pathfinding';
import type { Crossings } from './crossings';
import type { Occupancy } from './occupancy';
import type { Signals } from './signals';
import type { TrafficMemory } from './trafficMemory';

export interface FreightReport {
  /** Lorries currently on the road rather than parked. */
  onTheRoad: number;
  /** Units riding around in them right now. */
  inTransit: number;
  /** Deliveries and units delivered since the last daily reset. */
  deliveriesToday: number;
  deliveredToday: number;
  /** Mean door-to-door delivery time today, in ticks. */
  meanDeliveryTicks: number;
  /** Orders the last dispatch round could not place, in units. */
  unmetDemand: number;
  /** Lorries with no route to anywhere. */
  stuck: number;
}

/**
 * The city's lorries: who is carrying what, where, and why.
 *
 * The old supply chain moved goods by arithmetic -- a consumer reached out to
 * the nearest supplier on the same road network and the units appeared. It
 * produced the right totals and nothing else: distance cost nothing, a jam
 * cost nothing, and the roads the player had drawn were not carrying the
 * economy they were supposedly serving.
 *
 * Now the goods ride. Every delivery is a vehicle that queues at the lights,
 * waits at the level crossing, and takes as long as the road actually takes --
 * so an industrial estate on the far side of a congested corridor genuinely
 * starves the shops, and the fix is a road rather than a number.
 *
 * Dispatch is consumer-pull (the shop that is running low is the one that
 * orders), and it is entirely deterministic: buildings are scanned in id
 * order, orders are sorted with id as the tie-break, and nothing here draws
 * from the RNG. A save that resumes must dispatch the same lorries to the same
 * docks in the same order, or the identical-continuation guarantee is gone.
 */
export class Freight {
  report: FreightReport = emptyReport();

  private deliveries = 0;
  private delivered = 0;
  private deliveryTicks = 0;
  private unmet = 0;

  // --- Per tick ------------------------------------------------------------

  /** Publish where every lorry is, so cars and lorries see one shared snapshot. */
  forEachDriving(world: World, visit: (lorry: Lorry) => void): void {
    for (const lorry of world.lorries) {
      if (lorry.path) visit(lorry);
    }
  }

  /** Move every lorry, dock the ones that arrived, and retire the finished. */
  step(
    world: World,
    occupancy: Occupancy,
    crossings: Crossings,
    signals: Signals,
    tick: number,
  ): void {
    let onTheRoad = 0;
    let inTransit = 0;
    let stuck = 0;

    for (const lorry of world.lorries) {
      switch (lorry.state) {
        case LorryState.Idle:
          break;

        case LorryState.Loading:
          if (tick >= lorry.resumeAtTick) this.depart(world, lorry, tick);
          break;

        case LorryState.Unloading:
          if (tick >= lorry.resumeAtTick) this.headHome(world, lorry, tick);
          break;

        case LorryState.Stuck:
          if (tick >= lorry.resumeAtTick) this.retry(world, lorry, tick);
          stuck++;
          break;

        default: {
          if (!lorry.path) {
            this.strand(lorry, tick);
            break;
          }
          if (pathIsBroken(world, lorry)) {
            this.replan(world, lorry, tick);
            break;
          }
          onTheRoad++;
          inTransit += lorry.cargo;
          if (advanceVehicle(world, lorry, occupancy, crossings, signals, tick)) {
            this.arrive(world, lorry, tick);
          }
          break;
        }
      }
    }

    this.report = {
      onTheRoad,
      inTransit,
      deliveriesToday: this.deliveries,
      deliveredToday: this.delivered,
      meanDeliveryTicks: this.deliveries === 0 ? 0 : this.deliveryTicks / this.deliveries,
      unmetDemand: this.unmet,
      stuck,
    };
  }

  /** Reset the daily counters when the books close. */
  endDay(): void {
    this.deliveries = 0;
    this.delivered = 0;
    this.deliveryTicks = 0;
  }

  // --- Dispatch ------------------------------------------------------------

  /**
   * One round of order matching. Runs on a slow cadence: a shop's shelves do
   * not empty in a tick, and the search is the expensive part.
   */
  dispatch(world: World, cache: PathCache, traffic: TrafficMemory, tick: number): void {
    const suppliers = { raw: [] as Building[], goods: [] as Building[] };
    const orders: Order[] = [];

    // How fast an average shop sells, for the cover calculation below. A
    // per-shop history would be better and is not worth the extra saved
    // state: what matters is that a shop's shelves drain in days while a
    // factory's raw pile drains in hours.
    const shopCount = world.buildings.filter(
      (b) => b.alive && industryOf(b.type) === Industry.Retail,
    ).length;
    const shopDrain = (world.population * GOODS_PER_RESIDENT_PER_DAY) / 24
      / Math.max(1, shopCount);

    // What is already on its way, so five lorries do not all serve one shop.
    const inbound = new Map<BuildingId, number>();
    for (const lorry of world.lorries) {
      if (lorry.destination < 0 || lorry.cargo <= 0) continue;
      inbound.set(lorry.destination, (inbound.get(lorry.destination) ?? 0) + lorry.cargo);
    }

    for (const b of world.buildings) {
      if (!b.alive) continue;
      const industry = industryOf(b.type);
      const spec = specFor(b.type);

      if (industry === Industry.Primary && b.goodsStock > 0) suppliers.raw.push(b);
      if (industry === Industry.Secondary && b.goodsStock > 0) suppliers.goods.push(b);

      // A building that cannot operate cannot take a delivery either: nobody
      // is there to unload it.
      if (operatingRatio(b) <= 0) continue;

      if (industry === Industry.Secondary) {
        // A factory eats its raw materials at a known rate.
        addOrder(orders, b, CargoKind.Raw, b.rawStock, spec.storage, inbound,
          spec.rawPerHour * operatingRatio(b));
      } else if (industry === Industry.Retail) {
        addOrder(orders, b, CargoKind.Goods, b.goodsStock, spec.storage, inbound, shopDrain);
      }
    }

    // Whoever runs out first goes first, measured in hours of cover rather
    // than in units short. Sorting by the shortfall itself quietly starves
    // retail: a factory's raw bay is half again as deep as a shop's shelf, so
    // an empty factory always outranks an empty shop, and the city ends up
    // hauling ore to factories whose finished goods then sit there while the
    // shops run dry. Cover asks the question that actually matters -- how
    // long until this building stops working? -- and a factory burning four
    // units an hour is genuinely more urgent than a shop with two days left.
    orders.sort((a, b) => (a.cover - b.cover) || (a.consumer.id - b.consumer.id));

    this.unmet = 0;
    let placed = 0;
    for (const order of orders) {
      if (placed >= FREIGHT_DISPATCHES_PER_ROUND) {
        this.unmet += order.need;
        continue;
      }
      const pool = order.kind === CargoKind.Raw ? suppliers.raw : suppliers.goods;
      if (this.place(world, cache, traffic, order, pool, tick)) placed++;
      else this.unmet += order.need;
    }
  }

  /** Find the quickest supplier that can actually be driven to, and load up. */
  private place(
    world: World,
    cache: PathCache,
    traffic: TrafficMemory,
    order: Order,
    pool: Building[],
    tick: number,
  ): boolean {
    const consumer = order.consumer;
    world.refreshAccess(consumer);
    if (consumer.accessRoad < 0) return false;

    const nearest = pool
      .filter((s) => s.id !== consumer.id && s.goodsStock >= FREIGHT_MIN_LOAD)
      .map((s) => ({ s, d: manhattan(s.tile, consumer.tile) }))
      .sort((a, b) => (a.d - b.d) || (a.s.id - b.s.id))
      .slice(0, FREIGHT_SUPPLIER_CANDIDATES);

    let best: { supplier: Building; path: TileIndex[] } | null = null;
    let bestTicks = MAX_DELIVERY_TICKS;

    for (const { s } of nearest) {
      if (!this.hasSpareLorry(world, s)) continue;
      world.refreshAccess(s);
      if (s.accessRoad < 0) continue;

      const roads = cache.get(world.roads, `${s.accessRoad}:${consumer.accessRoad}`, () =>
        findPath(world.roads, s.accessRoad, consumer.accessRoad),
      );
      if (!roads) continue;

      // Priced at remembered speeds, so a jam really does shrink a factory's
      // catchment -- which a distance in tiles could never express.
      const ticks = traffic.driveTicks(roads);
      if (ticks < bestTicks) {
        bestTicks = ticks;
        best = { supplier: s, path: [s.tile, ...roads, consumer.tile] };
      }
    }
    if (!best) return false;

    const lorry = this.takeLorry(world, best.supplier);
    if (!lorry) return false;

    // The goods leave the shelf the moment they are on the truck. Anything
    // else would let the same units be promised twice.
    const load = Math.min(LORRY_CAPACITY, best.supplier.goodsStock, order.need);
    best.supplier.goodsStock -= load;

    lorry.cargo = load;
    lorry.cargoKind = order.kind;
    lorry.destination = consumer.id;
    lorry.state = LorryState.Loading;
    lorry.resumeAtTick = tick + LORRY_DWELL_TICKS;
    lorry.tripStartTick = tick;
    lorry.path = best.path;
    lorry.s = 0;
    lorry.v = 0;
    setPositionFromPath(lorry);
    // Held back until the dwell ends; `depart` puts it on the road.
    lorry.path = null;
    lorry.pendingPath = best.path;
    return true;
  }

  /** How many of this supplier's lorries are already out on a job. */
  private busyLorries(world: World, supplier: Building): number {
    let busy = 0;
    for (const lorry of world.lorries) {
      if (lorry.home === supplier.id && lorry.state !== LorryState.Idle) busy++;
    }
    return busy;
  }

  private hasSpareLorry(world: World, supplier: Building): boolean {
    return this.busyLorries(world, supplier) < LORRIES_PER_BUILDING;
  }

  /**
   * Find a lorry for this job: one parked at the depot, else any parked
   * anywhere, else a new one if the fleet has room.
   *
   * Reassigning idle lorries is what keeps the fleet honest. Letting a parked
   * lorry stay tied to the farm that first hired it made the fleet ossify: the
   * cap filled up with vehicles owned by depots with nothing to ship, while
   * the factories that needed raw materials could not get one, and the chain
   * starved with a hundred lorries standing idle.
   */
  private takeLorry(world: World, supplier: Building): Lorry | null {
    for (const lorry of world.lorries) {
      if (lorry.home === supplier.id && isSpare(lorry)) return lorry;
    }
    for (const lorry of world.lorries) {
      if (!isSpare(lorry)) continue;
      lorry.home = supplier.id;
      lorry.trips = 0;
      lorry.x = tileCenterX(supplier.tile);
      lorry.y = tileCenterY(supplier.tile);
      lorry.prevX = lorry.x;
      lorry.prevY = lorry.y;
      return lorry;
    }
    if (world.lorries.length >= MAX_LORRIES) return null;
    const lorry = createLorry(world.lorries.length, supplier.id, supplier.tile);
    world.lorries.push(lorry);
    return lorry;
  }

  // --- The trip ------------------------------------------------------------

  private depart(world: World, lorry: Lorry, tick: number): void {
    const path = lorry.pendingPath;
    lorry.pendingPath = null;
    if (!path) {
      this.strand(lorry, tick);
      return;
    }
    lorry.path = path;
    lorry.s = 0;
    lorry.v = 0;
    lorry.blockedTicks = 0;
    lorry.signalHold = -1;
    lorry.state = LorryState.Outbound;
    setPositionFromPath(lorry);
    void world;
  }

  private arrive(world: World, lorry: Lorry, tick: number): void {
    lorry.path = null;
    lorry.v = 0;

    if (lorry.state === LorryState.Returning) {
      this.park(world, lorry);
      return;
    }

    const consumer = world.buildings[lorry.destination];
    if (consumer && consumer.alive) {
      const spec = specFor(consumer.type);
      const target = lorry.cargoKind === CargoKind.Raw ? 'rawStock' : 'goodsStock';
      const room = Math.max(0, spec.storage - consumer[target]);
      const dropped = Math.min(lorry.cargo, room);
      consumer[target] += dropped;
      lorry.cargo -= dropped;

      this.deliveries++;
      this.delivered += dropped;
      this.deliveryTicks += tick - lorry.tripStartTick;
      lorry.trips++;
    }

    lorry.state = LorryState.Unloading;
    lorry.resumeAtTick = tick + LORRY_DWELL_TICKS;
  }

  /** Turn for home, empty or with whatever would not fit. */
  private headHome(world: World, lorry: Lorry, tick: number): void {
    lorry.destination = -1;
    const depot = world.buildings[lorry.home];
    if (!depot || !depot.alive) {
      this.retire(lorry);
      return;
    }
    const path = this.routeBetween(world, lorry.x, lorry.y, depot);
    if (!path) {
      this.strand(lorry, tick);
      return;
    }
    lorry.path = path;
    lorry.s = 0;
    lorry.v = 0;
    lorry.state = LorryState.Returning;
    setPositionFromPath(lorry);
  }

  /** Back in the yard: hand any undelivered load back and wait for work. */
  private park(world: World, lorry: Lorry): void {
    const depot = world.buildings[lorry.home];
    if (depot && depot.alive && lorry.cargo > 0) {
      const spec = specFor(depot.type);
      depot.goodsStock = Math.min(spec.storage, depot.goodsStock + lorry.cargo);
    }
    lorry.cargo = 0;
    lorry.state = LorryState.Idle;
    lorry.destination = -1;
    lorry.pendingPath = null;
    if (!depot || !depot.alive) this.retire(lorry);
  }

  private replan(world: World, lorry: Lorry, tick: number): void {
    const target = lorry.state === LorryState.Outbound
      ? world.buildings[lorry.destination]
      : world.buildings[lorry.home];
    if (!target || !target.alive) {
      this.abandon(world, lorry, tick);
      return;
    }
    const path = this.routeBetween(world, lorry.x, lorry.y, target);
    if (!path) {
      this.strand(lorry, tick);
      return;
    }
    lorry.path = path;
    lorry.s = 0;
    lorry.v = 0;
    setPositionFromPath(lorry);
  }

  private strand(lorry: Lorry, tick: number): void {
    if (lorry.state !== LorryState.Stuck) lorry.tripStartTick = Math.min(lorry.tripStartTick, tick);
    lorry.state = LorryState.Stuck;
    lorry.path = null;
    lorry.v = 0;
    lorry.resumeAtTick = tick + FREIGHT_RETRY_TICKS;
  }

  private retry(world: World, lorry: Lorry, tick: number): void {
    const consumer = lorry.destination >= 0 ? world.buildings[lorry.destination] : undefined;
    const depot = world.buildings[lorry.home];

    if (consumer && consumer.alive && lorry.cargo > 0) {
      const path = this.routeBetween(world, lorry.x, lorry.y, consumer);
      if (path) {
        lorry.path = path;
        lorry.s = 0;
        lorry.v = 0;
        lorry.state = LorryState.Outbound;
        setPositionFromPath(lorry);
        return;
      }
    }
    if (depot && depot.alive) {
      const path = this.routeBetween(world, lorry.x, lorry.y, depot);
      if (path) {
        lorry.destination = -1;
        lorry.path = path;
        lorry.s = 0;
        lorry.v = 0;
        lorry.state = LorryState.Returning;
        setPositionFromPath(lorry);
        return;
      }
    }
    if (tick - lorry.tripStartTick > FREIGHT_ABANDON_TICKS) {
      this.abandon(world, lorry, tick);
      return;
    }
    lorry.resumeAtTick = tick + FREIGHT_RETRY_TICKS;
  }

  /** Give up: the load is written off and the lorry with it. */
  private abandon(world: World, lorry: Lorry, tick: number): void {
    void world;
    void tick;
    this.retire(lorry);
  }

  private retire(lorry: Lorry): void {
    lorry.state = LorryState.Idle;
    lorry.home = -1;
    lorry.destination = -1;
    lorry.cargo = 0;
    lorry.path = null;
    lorry.pendingPath = null;
    lorry.v = 0;
  }

  /** Where the lorry is now, to a building's door. Shared with every other
   *  road vehicle, so a lorry, a bus and a fire engine leave a yard alike. */
  private routeBetween(world: World, x: number, y: number, to: Building): TileIndex[] | null {
    world.refreshAccess(to);
    return routeToBuilding(world, x, y, to);
  }

  /** A lorry whose depot or destination was demolished under it. */
  rescueOrphaned(world: World, tick: number): void {
    for (const lorry of world.lorries) {
      const depot = world.buildings[lorry.home];
      if (lorry.home >= 0 && (!depot || !depot.alive)) {
        // Including the ones parked in it: a lorry left pointing at a
        // demolished yard is a slot the fleet can never hand out again.
        this.retire(lorry);
        continue;
      }
      if (lorry.state === LorryState.Idle) continue;
      if (lorry.destination < 0) continue;
      const consumer = world.buildings[lorry.destination];
      if (consumer && consumer.alive) continue;
      // The shop it was serving is gone; take the load back to the yard.
      if (lorry.state === LorryState.Outbound || lorry.state === LorryState.Loading) {
        this.headHome(world, lorry, tick);
      } else {
        lorry.destination = -1;
      }
    }
  }

  restore(): void {
    this.report = emptyReport();
    this.deliveries = 0;
    this.delivered = 0;
    this.deliveryTicks = 0;
    this.unmet = 0;
  }
}

interface Order {
  consumer: Building;
  kind: CargoKind;
  need: number;
  /** Sim-hours of stock left, counting what is already on its way. */
  cover: number;
}

function addOrder(
  orders: Order[],
  consumer: Building,
  kind: CargoKind,
  onHand: number,
  storage: number,
  inbound: Map<BuildingId, number>,
  drainPerHour: number,
): void {
  const coming = inbound.get(consumer.id) ?? 0;
  const need = storage * FREIGHT_TARGET_FILL - onHand - coming;
  if (need < FREIGHT_MIN_LOAD) return;
  const cover = drainPerHour <= 0 ? Infinity : (onHand + coming) / drainPerHour;
  orders.push({ consumer, kind, need, cover });
}

function emptyReport(): FreightReport {
  return {
    onTheRoad: 0,
    inTransit: 0,
    deliveriesToday: 0,
    deliveredToday: 0,
    meanDeliveryTicks: 0,
    unmetDemand: 0,
    stuck: 0,
  };
}
