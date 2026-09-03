import { minutesToTicks } from '../core/clock';
import { idx, manhattan, neighbors, tileX, tileY } from '../core/grid';
import { Zone, type TileIndex } from '../core/types';
import type { Simulation } from '../sim/simulation';
import { applyTool, Tool } from '../ui/tools';
import { nearestRoad } from '../world/scenario';
import { groundSupports } from '../world/zoneRules';
import type { World } from '../world/world';

/**
 * A player, in about as many rules as a person uses in their first hour:
 * keep a bit of every kind of land zoned and served by a road, put up a power
 * station when the lights go out, extend the streets when the town runs out of
 * room, and raise the taxes rather than go broke.
 *
 * It exists so that "does a new game grow into a city?" can be a test rather
 * than something somebody has to sit and watch. Every action goes through
 * `applyTool` -- the same entry point the toolbar uses -- so it can only do
 * things a player could do, and it pays the same prices for them.
 *
 * Two rules earn their place by having been missing. It only zones land whose
 * road is **connected to the town**: without that check it happily zoned the
 * stubs left where a street ran into the river, and a few hundred people ended
 * up living somewhere with no route to work. And it keeps a *buffer* of zoned
 * land of every kind rather than reacting to shortages: growth here builds
 * what the city is short of, but only on land that is already zoned, so a city
 * with nowhere to put a factory starves its shops however loudly they complain.
 *
 * It is deliberately not clever. It does not plan districts, read the land
 * value map or route around congestion; it is the floor, not the ceiling.
 */
export class Autopilot {
  /** Sim minutes between decisions. A player does not re-plan every tick. */
  static readonly INTERVAL_MINUTES = 60;

  /** How much free zoned land of each kind to keep available, in tiles. */
  private static readonly BUFFER: ReadonlyArray<[Zone, number]> = [
    [Zone.ResidentialLow, 40],
    [Zone.Commercial, 20],
    [Zone.Office, 12],
    [Zone.Industrial, 20],
    [Zone.Farm, 10],
    [Zone.Forestry, 10],
    [Zone.Mining, 10],
    [Zone.Fishery, 10],
  ];

  /**
   * Rows the two districts can be linked across, in the order a player would
   * reach for them: the middle of the gap first, then further out. The town
   * opens with two links (at y=51 and y=76) and everybody drives through them.
   */
  private static readonly LINK_ROWS = [56, 66, 71, 46, 81, 61];

  private nextTick = 0;
  /** How far the streets have been pushed, so blocks go up in order. */
  private west = 60;
  private east = 124;
  /** How many extra crossings of the gap have been built, and when the last. */
  private links = 0;
  private lastLinkDay = -1;

  /** What it did, for a test to assert on and for a failure to explain itself. */
  readonly actions = { plants: 0, blocks: 0, zoned: 0, spurs: 0, links: 0, taxRises: 0 };

  /** Call every tick; it decides for itself when there is anything to do. */
  play(sim: Simulation): void {
    if (sim.clock.tick < this.nextTick) return;
    this.nextTick = sim.clock.tick + minutesToTicks(Autopilot.INTERVAL_MINUTES);

    const connected = roadsReachableFromTown(sim.world);
    this.balanceTheBooks(sim);
    this.keepTheLightsOn(sim, connected);
    this.keepLandZoned(sim, connected);
    this.easeTheTraffic(sim);
  }

  // --- The rules ------------------------------------------------------------

  /**
   * Nothing else works while the city is in the red, so this comes first: put
   * every rate up a notch whenever yesterday did not pay for itself.
   */
  private balanceTheBooks(sim: Simulation): void {
    if (!sim.economy.inOverdraft && sim.economy.lastDay.net >= 0) return;
    for (const category of ['residential', 'commercial', 'industrial', 'office'] as const) {
      sim.economy.setRate(category, sim.economy.rates[category] + 0.01);
    }
    this.actions.taxRises++;
  }

  /** A power station whenever the grid is short, sited away from the housing. */
  private keepTheLightsOn(sim: Simulation, connected: Uint8Array): void {
    const report = sim.power.report;
    if (report.shortfall <= 0) return;

    const site = this.plantSite(sim.world, connected);
    if (site < 0) return;
    if (applyTool(sim.world, sim.economy, Tool.Power, site).applied) this.actions.plants++;
  }

  /**
   * Keep a few tiles of every kind of land zoned, on a road, and connected.
   * Growth will build on it when the city needs it and leave it alone when it
   * does not, so being generous costs only the zoning fee.
   */
  private keepLandZoned(sim: Simulation, connected: Uint8Array): void {
    const free = this.countFreeZonedLand(sim.world, connected);

    for (const [zone, target] of Autopilot.BUFFER) {
      const short = target - (free.get(zone) ?? 0);
      if (short <= 0) continue;

      const painted = this.zone(sim, zone, short, connected);
      if (painted >= short) continue;

      // Nowhere left to put it: the town has to get bigger, or the outpost
      // has to follow its seam a little further along.
      if (isPrimary(zone)) this.extendOutpost(sim, zone, connected);
      else this.addBlock(sim, zone === Zone.ResidentialLow ? 'west' : 'east');
    }
  }

  /**
   * Another road across the gap when the commute gets long.
   *
   * This is the move the game is about. Everything the town does has to cross
   * two lanes between the housing and the work, so the first thing that breaks
   * as it grows is the journey to work -- and the answer a player reaches for
   * is another link. One at a time, so the effect of each is visible.
   */
  private easeTheTraffic(sim: Simulation): void {
    // One a day at most: a player builds a road, watches what it does to the
    // rush hour, and only then builds another.
    if (sim.clock.day === this.lastLinkDay) return;
    const trips = sim.stats.trips();
    if (trips.completed < 200 || trips.meanMinutes < 90) return;
    if (this.links >= Autopilot.LINK_ROWS.length) return;

    this.lastLinkDay = sim.clock.day;

    const y = Autopilot.LINK_ROWS[this.links++];
    for (let x = 85; x <= 99; x++) {
      applyTool(sim.world, sim.economy, Tool.Road, idx(x, y));
    }
    this.actions.links++;
  }

  // --- The moves ------------------------------------------------------------

  /**
   * Paint up to `limit` tiles of `zone` on connected, road-served ground that
   * supports it. Returns how many were painted, which is how the caller finds
   * out the town has run out of room.
   */
  private zone(sim: Simulation, zone: Zone, limit: number, connected: Uint8Array): number {
    const world = sim.world;
    let painted = 0;
    for (const tile of this.candidates(world, connected)) {
      if (painted >= limit) break;
      if (world.map.getZone(tile) !== Zone.None) continue;
      if (!world.canZone(tile, zone)) continue;
      if (!this.sideSuits(zone, tile)) continue;
      if (applyTool(world, sim.economy, toolFor(zone), tile).applied) painted++;
    }
    this.actions.zoned += painted;
    return painted;
  }

  /**
   * One more block of streets on the edge of a district: what turns "the town
   * is full" into "the town is bigger", and the most expensive thing here.
   *
   * The zoning beside it waits for the next planning round, once the
   * connectivity map has been redrawn -- a street that ran into the river is
   * not somewhere to live, and this is how that gets noticed.
   */
  private addBlock(sim: Simulation, side: 'west' | 'east'): void {
    const world = sim.world;
    const top = 44;
    const height = 40;
    const BLOCK = 5;
    const edge = side === 'west' ? this.west : this.east;
    const x = side === 'west' ? edge - BLOCK : edge + BLOCK;
    if (x < 4 || x > 123) return;

    // The new street, and the cross streets that reach it.
    for (let k = 0; k <= height; k++) applyTool(world, sim.economy, Tool.Road, idx(x, top + k));
    for (let dy = 0; dy <= height; dy += BLOCK) {
      for (let px = Math.min(x, edge); px <= Math.max(x, edge); px++) {
        applyTool(world, sim.economy, Tool.Road, idx(px, top + dy));
      }
    }

    if (side === 'west') this.west = x;
    else this.east = x;
    this.actions.blocks++;
  }

  /**
   * Run the service road at a primary outpost further along its seam, so the
   * next few tiles of ore or paddy can be zoned. Without this the city hits a
   * ceiling the moment the first patch is built out.
   */
  private extendOutpost(sim: Simulation, zone: Zone, connected: Uint8Array): void {
    const world = sim.world;
    const target = this.nearestUnzoned(world, zone);
    if (target < 0) return;

    const from = nearestRoad(world, target);
    if (from < 0 || connected[from] === 0 || manhattan(from, target) > 14) return;

    // Laid one tile at a time through the road tool, so the city pays for the
    // spur at the usual price and stops digging when it cannot afford it.
    let x = tileX(from);
    let y = tileY(from);
    const tx = tileX(target);
    const ty = tileY(target);
    while (x !== tx) {
      x += Math.sign(tx - x);
      applyTool(world, sim.economy, Tool.Road, idx(x, y));
    }
    while (y !== ty) {
      y += Math.sign(ty - y);
      applyTool(world, sim.economy, Tool.Road, idx(x, y));
    }
    this.actions.spurs++;
  }

  // --- Looking around -------------------------------------------------------

  /** Buildable tiles on a connected road, nearest the middle of town first. */
  private candidates(world: World, connected: Uint8Array): TileIndex[] {
    const out: TileIndex[] = [];
    for (let tile = 0; tile < world.map.zone.length; tile++) {
      if (!world.map.isBuildable(tile)) continue;
      const road = world.adjacentRoad(tile);
      if (road < 0 || connected[road] === 0) continue;
      out.push(tile);
    }
    return out;
  }

  /** How much free, connected, zoned land of each kind the city has left. */
  private countFreeZonedLand(world: World, connected: Uint8Array): Map<Zone, number> {
    const free = new Map<Zone, number>();
    for (const tile of this.candidates(world, connected)) {
      const zone = world.map.getZone(tile);
      if (zone === Zone.None) continue;
      free.set(zone, (free.get(zone) ?? 0) + 1);
    }
    return free;
  }

  /**
   * Housing west of the railway station district, work east of it: the town
   * starts that way and keeping to it is what leaves anybody with a commute
   * worth watching.
   */
  private sideSuits(zone: Zone, tile: TileIndex): boolean {
    if (isPrimary(zone)) return true;
    return zone === Zone.ResidentialLow ? tileX(tile) < 92 : tileX(tile) > 88;
  }

  /** The nearest tile the ground would support this zone on, but nobody has. */
  private nearestUnzoned(world: World, zone: Zone): TileIndex {
    const town = idx(92, 64);
    let best = -1;
    let bestDistance = Infinity;
    for (let tile = 0; tile < world.map.zone.length; tile++) {
      if (world.map.getZone(tile) !== Zone.None) continue;
      if (!world.map.isBuildable(tile)) continue;
      if (!groundSupports(world.map, zone, tile)) continue;
      const d = manhattan(town, tile);
      if (d < bestDistance) {
        bestDistance = d;
        best = tile;
      }
    }
    return best;
  }

  /**
   * Somewhere to put a power station: on a connected road, as far out of town
   * as the network reaches. Distance from the middle is a crude stand-in for
   * "not next to anybody's house", and it is the same instinct a player has
   * when they drag the plant to the edge of the map.
   */
  private plantSite(world: World, connected: Uint8Array): TileIndex {
    const town = idx(92, 64);
    let best = -1;
    let bestDistance = -1;
    for (let tile = 0; tile < world.map.zone.length; tile++) {
      if (!world.map.isBuildable(tile) || world.map.getZone(tile) !== Zone.None) continue;
      const road = world.adjacentRoad(tile);
      if (road < 0 || connected[road] === 0) continue;
      const d = manhattan(town, tile);
      if (d > bestDistance) {
        bestDistance = d;
        best = tile;
      }
    }
    return best;
  }
}

/**
 * The road tiles the town can actually be driven to, as a flood fill from the
 * middle of it.
 *
 * This is the check that stops the autopilot building somewhere unreachable.
 * The player has the same information for free -- they can see that the street
 * stops at the river -- which is exactly why a test player needs it too.
 */
function roadsReachableFromTown(world: World): Uint8Array {
  const seen = new Uint8Array(world.map.road.length);
  const start = nearestRoad(world, idx(92, 64));
  if (start < 0) return seen;

  const stack = [start];
  seen[start] = 1;
  while (stack.length > 0) {
    const tile = stack.pop()!;
    for (const n of neighbors(tile)) {
      if (world.map.isRoad(n) && seen[n] === 0) {
        seen[n] = 1;
        stack.push(n);
      }
    }
  }
  return seen;
}

function isPrimary(zone: Zone): boolean {
  return zone === Zone.Farm || zone === Zone.Forestry
    || zone === Zone.Fishery || zone === Zone.Mining;
}

function toolFor(zone: Zone): Tool {
  switch (zone) {
    case Zone.ResidentialLow:
      return Tool.ResidentialLow;
    case Zone.ResidentialHigh:
      return Tool.ResidentialHigh;
    case Zone.Commercial:
      return Tool.Commercial;
    case Zone.Industrial:
      return Tool.Industrial;
    case Zone.Office:
      return Tool.Office;
    case Zone.Farm:
      return Tool.Farm;
    case Zone.Forestry:
      return Tool.Forestry;
    case Zone.Fishery:
      return Tool.Fishery;
    case Zone.Mining:
      return Tool.Mining;
    default:
      return Tool.Select;
  }
}
