import { idx } from '../core/grid';
import { Resource, Terrain, Zone } from '../core/types';
import type { Simulation } from '../sim/simulation';
import { World } from '../world/world';

/**
 * Drop `count` power plants on whatever free tiles touch a road.
 *
 * Test towns get electricity because a town without it is not a city: nothing
 * operates, so nobody is employed, so nobody moves in, and there is no traffic
 * to measure. Tests that are about power say so explicitly instead.
 */
export function powerTown(world: World, count = 2): void {
  let built = 0;
  for (let i = 0; i < world.map.zone.length && built < count; i++) {
    if (!world.map.isBuildable(i) || world.adjacentRoad(i) < 0) continue;
    if (world.placePowerPlant(i)) built++;
  }
}

/**
 * Flatten a world's ground.
 *
 * The generated map has hills in it, which is the point of the terrain -- but
 * a fixture built to measure something else (a queue, a supply chain, a
 * train's acceleration) wants a controlled world, and a fixture that clears
 * the water and then lays a grid over whatever the noise produced is not one.
 * Anything that is actually about the ground says so by not calling this.
 */
export function flatten(world: World): void {
  world.map.height.fill(0);
  world.map.roadRaise.fill(0);
  world.map.railRaise.fill(0);
  world.map.refreshRelief();
}

/** Advance a simulation by whole ticks. */
export function run(sim: Simulation, ticks: number): void {
  for (let i = 0; i < ticks; i++) sim.tick();
}

/**
 * A small city that has everything it needs, laid out the way the model wants:
 * housing west, shops and offices in the middle, industry and the primary
 * industry that feeds it east, all on one road network, with power.
 *
 * This is the fixture for anything that asks "does a working city work?" --
 * the economy paying for itself, the supply chain reaching the shops. It is
 * deliberately compact, because the interesting failures (a chain that is
 * zoned but not connected) are then a single edit away.
 */
export function compactCity(): World {
  const w = new World(41);
  w.map.terrain.fill(Terrain.Grass);
  w.map.resource.fill(Resource.None);
  flatten(w);

  // A 5-tile street grid, 70 tiles wide.
  const top = 20;
  const height = 30;
  for (let y = top; y <= top + height; y += 5) {
    for (let x = 10; x <= 80; x++) w.placeRoad(idx(x, y));
  }
  for (let x = 10; x <= 80; x += 5) {
    for (let y = top; y <= top + height; y++) w.placeRoad(idx(x, y));
  }

  // Fertile ground and a seam under the eastern end, for the primary industry.
  for (let x = 62; x <= 80; x++) {
    for (let y = top; y <= top + height; y++) {
      w.map.resource[idx(x, y)] = x > 72 ? Resource.Ore : Resource.Fertile;
    }
  }

  const zoneBand = (x0: number, x1: number, zone: Zone): void => {
    for (let x = x0; x <= x1; x++) {
      for (let y = top; y <= top + height; y++) {
        const tile = idx(x, y);
        if (w.adjacentRoad(tile) >= 0) w.paintZone(tile, zone);
      }
    }
  };

  zoneBand(10, 28, Zone.ResidentialLow);
  zoneBand(29, 38, Zone.Commercial);
  zoneBand(41, 48, Zone.Office);
  zoneBand(49, 61, Zone.Industrial);
  zoneBand(62, 72, Zone.Farm);
  zoneBand(73, 80, Zone.Mining);

  powerTown(w, 5);
  return w;
}
