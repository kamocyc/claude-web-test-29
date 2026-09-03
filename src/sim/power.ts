import { MAP_SIZE, POWER_PLANT_OUTPUT } from '../config';
import { neighbors } from '../core/grid';
import { BuildingType, type TileIndex } from '../core/types';
import { specFor, type Building } from '../world/buildings';
import type { Policies } from './policies';
import type { World } from '../world/world';

/** One connected road network, and what the buildings hanging off it need. */
export interface GridSummary {
  id: number;
  supply: number;
  demand: number;
  /** Buildings on this network that the supply did not reach. */
  unpowered: number;
}

export interface GridReport {
  /** One entry per connected road network that has anything on it. */
  grids: number;
  supply: number;
  demand: number;
  /**
   * Demand the plants could not meet, summed per network.
   *
   * Not `demand - supply`: power does not travel between two unconnected road
   * networks, so a city with a spare plant in the north and a dark district in
   * the south is short of power even though its totals balance. Summing the
   * per-network shortfalls is the number that tells the player to build.
   */
  shortfall: number;
  /** Buildings left dark, either off-grid or short of capacity. */
  unpowered: number;
  /** ...of which are not connected to any road at all, so have no cable. */
  offGrid: number;
  /** Power stations that are actually generating. */
  plants: number;
  /** The networks with anything on them, worst shortfall first. */
  networks: GridSummary[];
}

/**
 * Electricity, distributed along the road network.
 *
 * There is no separate pylon layer, and that is a deliberate simplification
 * rather than a missing feature: cables run under the street. It means the
 * road network the player is already thinking about *is* the utility network,
 * so connecting a distant mining district costs a road rather than a second
 * parallel thing to draw -- and an unconnected outpost is dark for a reason
 * the player can see on the map.
 *
 * Within one connected network, power is not routed: it is pooled. Capacity is
 * shared out to buildings in id order until it runs out, so a shortage browns
 * out the newest buildings first and the player sees the city stop growing
 * rather than flicker at random.
 */
export class PowerGrid {
  /** Road tile -> grid id, or -1. Rebuilt when the road network changes. */
  private readonly gridOf = new Int32Array(MAP_SIZE * MAP_SIZE).fill(-1);
  private roadsVersion = -1;
  private gridCount = 0;

  report: GridReport = emptyReport();

  /**
   * Recompute who has power. Called on a slow cadence: the answer only changes
   * when a building appears, a plant is built, or the roads change.
   */
  update(world: World, policies?: Policies): void {
    this.refreshComponents(world);
    // What a building draws is the spec's figure as amended by the city's
    // by-laws: the energy ordinance is a discount on this one number, so the
    // grid, the report and the panel all see the same reduced demand.
    const draws = (b: Building): number => policies
      ? policies.powerDraw(specFor(b.type).power)
      : specFor(b.type).power;

    let plants = 0;
    const supply = new Float64Array(this.gridCount + 1);
    const demand = new Float64Array(this.gridCount + 1);
    const members: Building[][] = [];
    for (let i = 0; i <= this.gridCount; i++) members.push([]);

    for (const b of world.buildings) {
      if (!b.alive) continue;
      const grid = this.gridFor(world, b);
      if (grid < 0) {
        // Off the network entirely: no road, so no cable.
        b.powered = false;
        continue;
      }
      if (b.type === BuildingType.PowerPlant) {
        plants++;
        // A plant needs its own staff to run, so a city that cannot fill the
        // jobs cannot run the plant at full output either -- but never at
        // nothing, or a brand new plant could never power the homes whose
        // residents are going to staff it.
        b.powered = true;
        const staffing = b.capacity === 0 ? 1 : b.occupants.length / b.capacity;
        supply[grid] += POWER_PLANT_OUTPUT * Math.max(0.25, staffing);
        continue;
      }
      demand[grid] += draws(b);
      members[grid].push(b);
    }

    let unpowered = 0;
    const networks: GridSummary[] = [];
    for (let grid = 0; grid <= this.gridCount; grid++) {
      let remaining = supply[grid];
      let dark = 0;
      for (const b of members[grid]) {
        const draw = draws(b);
        if (remaining >= draw) {
          remaining -= draw;
          b.powered = true;
        } else {
          b.powered = false;
          dark++;
        }
      }
      unpowered += dark;
      if (supply[grid] > 0 || demand[grid] > 0) {
        networks.push({ id: grid, supply: supply[grid], demand: demand[grid], unpowered: dark });
      }
    }

    let totalSupply = 0;
    let totalDemand = 0;
    let shortfall = 0;
    for (let grid = 0; grid <= this.gridCount; grid++) {
      totalSupply += supply[grid];
      totalDemand += demand[grid];
      shortfall += Math.max(0, demand[grid] - supply[grid]);
    }
    let offGrid = 0;
    for (const b of world.buildings) {
      if (b.alive && !b.powered && this.gridFor(world, b) < 0) offGrid++;
    }

    // Worst first: the network the player has to do something about is the
    // one at the top of the list, not the one that happens to be grid 0.
    networks.sort((a, b) => (b.demand - b.supply) - (a.demand - a.supply));

    this.report = {
      grids: networks.length,
      supply: totalSupply,
      demand: totalDemand,
      shortfall,
      unpowered: unpowered + offGrid,
      offGrid,
      plants,
      networks,
    };
  }

  /** The grid a building draws from: the one its access road belongs to. */
  private gridFor(world: World, b: Building): number {
    world.refreshAccess(b);
    return b.accessRoad >= 0 ? this.gridOf[b.accessRoad] : -1;
  }

  /** Which grid a tile is on, for the overlay. */
  gridAt(tile: TileIndex): number {
    return tile >= 0 ? this.gridOf[tile] : -1;
  }

  /** Flood fill the road network into connected components. */
  private refreshComponents(world: World): void {
    if (world.roads.version === this.roadsVersion) return;
    this.roadsVersion = world.roads.version;
    this.gridOf.fill(-1);
    this.gridCount = 0;

    const stack: TileIndex[] = [];
    for (let tile = 0; tile < this.gridOf.length; tile++) {
      if (!world.map.isRoad(tile) || this.gridOf[tile] >= 0) continue;

      const grid = this.gridCount++;
      this.gridOf[tile] = grid;
      stack.push(tile);
      while (stack.length > 0) {
        const current = stack.pop()!;
        for (const n of neighbors(current)) {
          if (world.map.isRoad(n) && this.gridOf[n] < 0) {
            this.gridOf[n] = grid;
            stack.push(n);
          }
        }
      }
    }
  }
}

function emptyReport(): GridReport {
  return {
    grids: 0,
    supply: 0,
    demand: 0,
    shortfall: 0,
    unpowered: 0,
    offGrid: 0,
    plants: 0,
    networks: [],
  };
}
