import { idx, manhattan, tileX, tileY } from '../core/grid';
import { BuildingType, Resource, Zone, type BuildingId, type TileIndex } from '../core/types';
import { findPath } from '../sim/pathfinding';
import { createLine } from './lineBuilder';
import { World } from './world';

/** The level the opening town's site is graded to, out of MAX_TERRAIN_HEIGHT. */
const TOWN_HEIGHT = 2;

/** The seed the game starts a new city from, so a test can start the same one. */
export const STARTING_SEED = 20260831;

/** Where the camera looks when a new game opens: the middle of the town. */
export const STARTING_VIEW = { x: 92, y: 64 };

/** A brand new game: the opening scenario on a fresh map. */
export function newGame(seed = STARTING_SEED): World {
  const world = new World(seed);
  seedStartingTown(world);
  return world;
}

/**
 * The opening scenario: two districts -- housing in the west, workplaces in
 * the east -- separated by a gap that only two roads and one railway cross,
 * with a power station, a small industrial strip, and whatever primary
 * industry the ground nearby happens to support.
 *
 * The shape is the point. A uniform grid has spare capacity everywhere, so
 * nothing ever jams and driving always wins; the interesting decisions only
 * appear once the connection between where people live and where they work is
 * the scarce thing. Here the corridor congests at rush hour, and that is
 * exactly when the train starts winning the comparison.
 *
 * The town is deliberately started *incomplete*: it has enough of a supply
 * chain to be alive and not enough to stay that way, so the first thing the
 * player has to do is find the fertile ground, the woods or the seam, and
 * connect them.
 */
export function seedStartingTown(world: World): void {
  const BLOCK = 5;
  const top = 44;
  const height = 40;
  const west = { x: 60, w: 25 };
  const east = { x: 99, w: 25 };

  // The site is levelled before a single street is laid, which is what towns
  // do and what this one needs: a grid laid across whatever the noise
  // produced would have its railway refused halfway along, and the opening
  // scenario has to be a city that works. The ground outside this rectangle
  // is left as it was found -- that is where the player meets the hills.
  world.levelGround(west.x - 3, top - 3, east.x + east.w + 4, top + height + 3, TOWN_HEIGHT);
  // Two rows clear of the street at top+20: a station needs a free tile that
  // touches track on one side and pavement on the other, and that gap is the
  // only place such a tile exists.
  const railRow = top + 18;
  const linkRows = [top + 7, top + 32];

  const district = (d: { x: number; w: number }, zone: Zone): void => {
    for (let dy = 0; dy <= height; dy += BLOCK) {
      for (let k = 0; k <= d.w; k++) world.placeRoad(idx(d.x + k, top + dy));
    }
    for (let dx = 0; dx <= d.w; dx += BLOCK) {
      for (let k = 0; k <= height; k++) world.placeRoad(idx(d.x + dx, top + k));
    }
    for (let x = d.x; x <= d.x + d.w; x++) {
      for (let y = top; y <= top + height; y++) {
        const tile = idx(x, y);
        if (world.adjacentRoad(tile) >= 0) world.paintZone(tile, zone);
      }
    }
  };

  district(west, Zone.ResidentialLow);
  district(east, Zone.Commercial);

  // Two road links across the gap. Everything drives through these, which is
  // what makes them back up.
  for (const y of linkRows) {
    for (let x = west.x + west.w; x <= east.x; x++) world.placeRoad(idx(x, y));
  }

  // The railway goes down last, so every street it meets becomes a level
  // crossing rather than a gap in the line.
  for (let x = west.x + 2; x <= east.x + east.w - 2; x++) {
    world.placeRail(idx(x, railRow));
  }

  // Two stations per district, on x values off the 5-tile street grid so the
  // tile is free, sitting right among the blocks they serve. Siting is what
  // makes a line worth riding: put a station where nobody lives and the walk
  // to it eats the time the train saves.
  const stations: BuildingId[] = [];
  for (const x of [west.x + 8, west.x + 18, east.x + 7, east.x + 17]) {
    const station = world.placeStation(idx(x, railRow + 1));
    if (station) stations.push(station.id);
  }
  createLine(world, stations);

  // Industry along the southern edge of the commercial district, downwind of
  // the housing: close enough to supply the shops, far enough that the noise
  // does not land on anybody's home.
  for (let x = east.x; x <= east.x + east.w; x++) {
    for (let y = top + height - 4; y <= top + height; y++) {
      const tile = idx(x, y);
      if (world.adjacentRoad(tile) >= 0) world.paintZone(tile, Zone.Industrial);
    }
  }

  // Two plants on the eastern edge, where there is room and nobody lives. The
  // service road goes in first: a plant needs a road to feed the cable into.
  for (const y of [top + 2, top + height - 2]) {
    world.placeRoad(idx(east.x + east.w + 1, y));
    world.placePowerPlant(idx(east.x + east.w + 2, y));
  }

  seedCivicServices(world, west, top);

  seedPrimaryIndustry(world);
}

/**
 * One school, one fire station and one police station, in the middle of the
 * housing where a small town would actually have put them.
 *
 * The town starts with the civic minimum rather than with nothing, for the
 * same reason it starts with two power plants: the opening city has to be a
 * *working* one that is visibly running out of headroom, not a ruin. Each of
 * these reaches a couple of dozen blocks along the roads, so the district the
 * player grows next is out of range of all three -- which is the lesson, and
 * it is a much better one than watching the starting town burn.
 */
function seedCivicServices(world: World, west: { x: number; w: number }, top: number): void {
  const spots: Array<[TileIndex, BuildingType]> = [
    [idx(west.x + 3, top + 8), BuildingType.School],
    [idx(west.x + 3, top + 23), BuildingType.FireStation],
    [idx(west.x + 13, top + 13), BuildingType.PoliceStation],
  ];
  for (const [tile, type] of spots) {
    if (world.placeService(tile, type)) continue;
    // The 5-tile street grid puts a road on every fifth row and column, so a
    // tile that is already spoken for has a free neighbour next to it.
    for (const dx of [1, -1, 2, -2]) {
      if (world.placeService(tile + dx, type)) break;
    }
  }
}

/**
 * Zone whatever primary industry the ground around the town supports, and put
 * a road to it.
 *
 * The deposits are generated from the map seed, so this cannot be hand-placed:
 * it looks for the nearest patch of each kind, runs a road out to it and zones
 * a few tiles. That leaves the player with one of each industry working and
 * the obvious next move -- expanding the one their land is actually good for.
 */
function seedPrimaryIndustry(world: World): void {
  const town = idx(92, 64);
  for (const [resource, zone] of [
    [Resource.Fertile, Zone.Farm],
    [Resource.Forest, Zone.Forestry],
    [Resource.Ore, Zone.Mining],
  ] as const) {
    const patch = nearestResource(world, town, resource);
    if (patch < 0) continue;

    // The spur has to start from a tile that is already road: a lane that
    // touches nothing is off the network, which means off the power grid and
    // out of reach of the factories -- the outpost would be dead on arrival.
    const from = nearestRoad(world, patch);
    if (from < 0) continue;

    const laid = connectByRoad(world, from, patch);
    // The river will not be bridged by a road tool that refuses to build on
    // water, so a spur can end up on the far bank with a gap in the middle.
    // An outpost the city cannot reach is worse than no outpost, so the spur
    // is taken back up rather than left as a stub.
    if (!findPath(world.roads, from, patch)) {
      for (const tile of laid) world.bulldoze(tile);
      continue;
    }

    // A service road across the patch, and the ground either side of it zoned:
    // enough to feed a couple of factories, and nowhere near enough to feed
    // the city this will grow into.
    const px = tileX(patch);
    const py = tileY(patch);
    for (let dx = -3; dx <= 3; dx++) world.placeRoad(world.map.at(px + dx, py));
    for (let dx = -3; dx <= 3; dx++) {
      for (const dy of [-1, 1]) {
        const tile = world.map.at(px + dx, py + dy);
        if (tile >= 0 && world.map.getResource(tile) === resource) world.paintZone(tile, zone);
      }
    }
  }
}

/**
 * The road tile closest to `tile`, or -1 if the city has no roads at all.
 *
 * Exported with `connectByRoad` below because they are the two primitives any
 * city building needs -- the opening scenario runs its spurs out to the
 * resource patches with them, and so does the autopilot the tests play with.
 */
export function nearestRoad(world: World, tile: TileIndex): TileIndex {
  let best = -1;
  let bestDistance = Infinity;
  for (let i = 0; i < world.map.road.length; i++) {
    if (!world.map.isRoad(i)) continue;
    const d = manhattan(tile, i);
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  }
  return best;
}

function nearestResource(world: World, from: TileIndex, resource: Resource): TileIndex {
  let best = -1;
  let bestDistance = Infinity;
  for (let tile = 0; tile < world.map.resource.length; tile++) {
    if (world.map.getResource(tile) !== resource) continue;
    const d = manhattan(from, tile);
    if (d < bestDistance) {
      bestDistance = d;
      best = tile;
    }
  }
  return best;
}

/** An L-shaped road between two tiles. Returns the tiles it actually laid. */
export function connectByRoad(world: World, from: TileIndex, to: TileIndex): TileIndex[] {
  const laid: TileIndex[] = [];
  let x = tileX(from);
  let y = tileY(from);
  const tx = tileX(to);
  const ty = tileY(to);
  const step = (tile: TileIndex): void => {
    if (world.placeRoad(tile)) laid.push(tile);
  };
  while (x !== tx) {
    x += Math.sign(tx - x);
    step(idx(x, y));
  }
  while (y !== ty) {
    y += Math.sign(ty - y);
    step(idx(x, y));
  }
  return laid;
}
