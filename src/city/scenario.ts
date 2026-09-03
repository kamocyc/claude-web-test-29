import { Vector3 } from 'three';
import { draw, smoothProfile, type Waypoint } from '../track/app/sketch';
import { getClass } from '../track/network/classes';
import { anchorFromNode } from '../track/network/editing';
import type { NetNode } from '../track/network/network';
import type { ZoneType } from '../track/network/zoning';
import type { Heightfield } from '../track/terrain/heightfield';
import type { CityWorld } from './world';
import { Resource, WATER_LEVEL } from './terrain';

/**
 * The town the game opens on.
 *
 * The tile city started from a grid because a grid was all a tile map could
 * be. This one is laid with the same tool the player has: streets are drawn as
 * alignments that follow the ground, so the opening town already shows what
 * the city is now made of -- a road that bends around a hill, a railway on a
 * gentler gradient than the street beside it, a bridge over the valley.
 *
 * The shape is the same argument the tile town made, though. Housing on one
 * side, work on the other, and **one street between them**: a town with spare
 * capacity everywhere never jams, and the interesting decisions only start
 * once the connection between where people live and where they work is the
 * scarce thing.
 */

/** Half the width and depth of the town's footprint [m]. */
const TOWN_HALF_WIDTH = 620;
const TOWN_HALF_DEPTH = 380;

/** The main street runs this far either side of the centre. */
const MAIN_STREET_HALF = 560;
/** Cross streets every this many metres, which sets the block size. */
const BLOCK = 140;
/** How far the cross streets run either side of the main street. */
const CROSS_REACH = 170;
/** The railway runs parallel to the main street, this far north of it. */
const RAIL_OFFSET = 330;
const RAIL_HALF = 520;
const STATION_LENGTH = 120;
const STATION_OFFSET = 360;
const STATION_NAMES = ['西町', '東町'] as const;

export interface ScenarioOptions {
  /** Lay the railway and its two stations. Off in tests that only want roads. */
  rail?: boolean;
  /** Paint the opening zones. */
  zones?: boolean;
  /** Put the town here instead of on the site the search picks. */
  site?: Vector3;
}

/**
 * Where the opening town sits.
 *
 * Searched for rather than fixed. The terrain comes from a seed, so a hard
 * coded centre puts the town on a hillside on most of them -- and a town whose
 * own streets break the gradient limit is a bad first thing to show anybody:
 * every warning in the panel would be one the game made rather than one the
 * player made.
 */
export function findTownSite(field: Heightfield): Vector3 {
  let best = new Vector3(0, field.baseHeightAt(0, 0), 0);
  let bestScore = Infinity;
  for (let z = -1400; z <= 1400; z += 160) {
    for (let x = -1400; x <= 1400; x += 160) {
      let slope = 0;
      let wet = 0;
      let samples = 0;
      for (let dz = -TOWN_HALF_DEPTH; dz <= TOWN_HALF_DEPTH; dz += 80) {
        for (let dx = -TOWN_HALF_WIDTH; dx <= TOWN_HALF_WIDTH; dx += 80) {
          const h = field.baseHeightAt(x + dx, z + dz);
          // The slope to the next sample, which is what a street has to climb.
          slope += Math.abs(h - field.baseHeightAt(x + dx + 40, z + dz + 40));
          if (h < WATER_LEVEL) wet++;
          samples++;
        }
      }
      // Flat ground wins, and a town centre standing in the lake loses. A
      // little water nearby is not penalised out of existence: a fishery needs
      // a shore, and the valley is where the fertile ground is.
      const score = slope / samples + (wet / samples) * 40;
      if (score < bestScore) {
        bestScore = score;
        best = new Vector3(x, field.baseHeightAt(x, z), z);
      }
    }
  }
  return best;
}

/** Build the opening town into an empty world. Returns where it was put. */
export function seedStartingTown(world: CityWorld, options: ScenarioOptions = {}): Vector3 {
  const { net, field } = world;
  const site = options.site ?? findTownSite(field);
  const rail = options.rail ?? true;
  const zones = options.zones ?? true;

  // The main street. Its profile is smoothed to a gentler grade than the
  // ground so that the engine has something to cut, fill and bridge -- a road
  // that simply follows every hollow is a road nobody had to think about.
  const main: Waypoint[] = [];
  for (let d = -MAIN_STREET_HALF; d <= MAIN_STREET_HALF; d += 70) {
    main.push({ x: site.x + d, z: site.z });
  }
  draw(net, field, 'road_medium', smoothProfile(field, main, 'road_medium', { grade: 0.05 }), {
    straight: true,
  });

  // Cross streets, north and south of it. Drawn as two separate runs from the
  // main street outward so each one joins it at a proper junction.
  for (let d = -MAIN_STREET_HALF + BLOCK; d < MAIN_STREET_HALF; d += BLOCK) {
    for (const side of [1, -1] as const) {
      const points: Waypoint[] = [];
      for (let out = 0; out <= CROSS_REACH; out += 60) {
        points.push({ x: site.x + d, z: site.z + side * out });
      }
      draw(net, field, 'road_small', smoothProfile(field, points, 'road_small', { grade: 0.07 }), {
        straight: true,
      });
    }
  }

  if (rail) seedRailway(world, site);
  if (zones) paintOpeningZones(world, site);
  return site;
}

/**
 * The railway: one line along the north edge of the town, with a station at
 * each end of the built-up area.
 *
 * Single track on purpose. The town starts with the *minimum* railway that is
 * worth running, so that doubling it, or adding a passing loop, is a decision
 * the player gets to make rather than one already made for them.
 */
function seedRailway(world: CityWorld, site: Vector3): void {
  const { net, field } = world;
  const railZ = site.z + RAIL_OFFSET;
  const from = site.x - RAIL_HALF;
  const to = site.x + RAIL_HALF;

  // The line's vertical profile is worked out *before* anything is laid, so
  // the stations can be put at the height the railway will actually be at.
  // Placing them on the bare ground and then drawing up to them asks the
  // approach to climb several metres in no distance at all, and the line ends
  // up in three disconnected pieces -- which is exactly what happened first.
  const spine: Waypoint[] = [];
  for (let x = from; x <= to; x += 40) spine.push({ x, z: railZ });
  const profile = smoothProfile(field, spine, 'rail_single', { grade: 0.02 });
  const railYAt = (x: number): number => {
    const t = (x - from) / (to - from);
    const at = Math.max(0, Math.min(profile.length - 1, t * (profile.length - 1)));
    const i = Math.max(0, Math.min(profile.length - 2, Math.floor(at)));
    const f = at - i;
    const y0 = profile[i].y ?? field.baseHeightAt(profile[i].x, railZ);
    const y1 = profile[i + 1].y ?? field.baseHeightAt(profile[i + 1].x, railZ);
    return y0 + (y1 - y0) * f;
  };

  // Heading 0 puts the station tracks along +X, which is the way this railway
  // runs. (Heading is the track direction, not the platform's.)
  const stations = STATION_NAMES.map((name, i) => {
    const x = site.x + (i === 0 ? -STATION_OFFSET : STATION_OFFSET);
    return net.addStation({
      name,
      center: new Vector3(x, railYAt(x), railZ),
      heading: 0,
      length: STATION_LENGTH,
      trackCount: 1,
      platformCount: 1,
      elevated: false,
    });
  });

  const cls = getClass('rail_single');
  /** The two ends of a station's single track, west first. */
  const endsOf = (station: (typeof stations)[number]): [NetNode, NetNode] => {
    const seg = net.getSegment(station.tracks[0].segment);
    const nodes = [net.getNode(seg.a), net.getNode(seg.b)];
    return nodes[0].pos.x <= nodes[1].pos.x ? [nodes[0], nodes[1]] : [nodes[1], nodes[0]];
  };

  const [westA, eastA] = endsOf(stations[0]);
  const [westB, eastB] = endsOf(stations[1]);

  // A station's track is offset from the station's centre line (the platform
  // stands between them), so a line drawn down the centre has to swerve into
  // the platform road and the joint picks up curvature -- which the engine
  // rightly reports as a kink. Taking the track's own z for the plain line
  // puts the whole railway on one straight, and the joints come out clean.
  const trackZ = westA.pos.z;

  /**
   * One run of plain track between two points, at the line's own profile.
   *
   * Where an end is a station track, the anchor comes from its node so the new
   * track picks up its position, tangent and level, and the joint is
   * continuous rather than a kink at the platform end.
   */
  const run = (a: Vector3 | NetNode, b: Vector3 | NetNode): void => {
    const p0 = 'pos' in a ? a.pos : a;
    const p1 = 'pos' in b ? b.pos : b;
    const span = p1.x - p0.x;
    if (Math.abs(span) < 40) return;
    const steps = Math.max(1, Math.round(Math.abs(span) / 80));
    const points: Waypoint[] = [];
    for (let i = 0; i <= steps; i++) {
      const x = p0.x + (span * i) / steps;
      // The ends take the exact height of what they join, so the approach
      // meets the platform level rather than aiming near it.
      const y = i === 0 ? p0.y : i === steps ? p1.y : railYAt(x);
      points.push({ x, z: trackZ, y });
    }
    draw(net, field, 'rail_single', points, {
      straight: true,
      start: 'pos' in a ? anchorFromNode(net, a, cls) : undefined,
      end: 'pos' in b ? anchorFromNode(net, b, cls) : undefined,
    });
  };

  run(new Vector3(from, railYAt(from), trackZ), westA);
  run(eastA, westB);
  run(eastB, new Vector3(to, railYAt(to), trackZ));
}

/**
 * The opening zones: housing in the west, shops in the middle, industry in the
 * east, and whatever primary industry the ground allows.
 *
 * Painted along the streets rather than over a rectangle, because that is what
 * zoning is now: a use painted on the ground, which the engine turns into
 * plots wherever a road runs past it. The town is deliberately started
 * *incomplete* -- no offices, no flats, and only one of whatever primary
 * industry happens to be under it -- so the first thing the player does is
 * decide what this town is going to be.
 */
function paintOpeningZones(world: CityWorld, site: Vector3): void {
  const { terrain } = world;
  const paint = (x: number, z: number, zone: ZoneType): void => {
    world.zones.paint(x, z, 22, zone);
  };

  for (let d = -MAIN_STREET_HALF + 40; d <= MAIN_STREET_HALF - 40; d += 24) {
    const use: ZoneType = d < -180 ? 'residential' : d < 180 ? 'commercial' : 'industrial';
    for (const side of [1, -1] as const) paint(site.x + d, site.z + side * 16, use);
  }

  // Along the cross streets: housing behind the housing, more of the same
  // behind the shops. The second row is what gives the town somewhere to grow.
  for (let d = -MAIN_STREET_HALF + BLOCK; d < MAIN_STREET_HALF; d += BLOCK) {
    for (let out = 40; out <= CROSS_REACH - 20; out += 24) {
      for (const side of [1, -1] as const) {
        const z = site.z + side * out;
        const use: ZoneType = d < -180 ? 'residential' : d < 180 ? 'commercial' : 'industrial';
        paint(site.x + d + 16, z, use);
        paint(site.x + d - 16, z, use);
      }
    }
  }

  // Primary industry, where the ground actually supports it and a street
  // already runs past -- an outpost the city cannot reach is worse than none.
  for (let d = -MAIN_STREET_HALF; d <= MAIN_STREET_HALF; d += 24) {
    for (const side of [1, -1] as const) {
      const x = site.x + d;
      const z = site.z + side * 16;
      const resource = terrain.resourceAt(x, z);
      if (resource === Resource.Fertile && terrain.nearWater(x, z, 120)) paint(x, z, 'farm');
      else if (resource === Resource.Forest) paint(x, z, 'forestry');
      else if (resource === Resource.Ore) paint(x, z, 'mining');
    }
  }
}
