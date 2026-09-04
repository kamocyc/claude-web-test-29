import { Vector3 } from 'three';
import { draw, smoothProfile, type Waypoint } from '../track/app/sketch';
import { getClass } from '../track/network/classes';
import { anchorFromNode, type Anchor } from '../track/network/editing';
import type { NetworkClass } from '../track/network/classes';
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
/** How far short of the track a station's forecourt stops [m]. */
const FORECOURT_SETBACK = 30;

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
      const score = siteScore(field, x, z);
      if (score < bestScore) {
        bestScore = score;
        best = new Vector3(x, field.baseHeightAt(x, z), z);
      }
    }
  }
  return best;
}

/**
 * How bad a site is, judged on the streets that would be laid there.
 *
 * Not the average slope of a rectangle. The engine refuses a road for the one
 * grade it cannot climb, so what matters is the steepest thing the *layout*
 * would have to do -- and the layout is known: a main street along z, cross
 * streets along x, and back streets joining their ends. Scoring the rectangle
 * instead picked sites that were flat on average with one bank across the
 * middle, and the town filed 32% gradient warnings against itself on the
 * first screen the player ever sees.
 */
function siteScore(field: Heightfield, x: number, z: number): number {
  let steepest = 0;
  let wet = 0;
  let samples = 0;

  const along = (
    from: { x: number; z: number },
    to: { x: number; z: number },
    step: number,
  ): void => {
    const span = Math.hypot(to.x - from.x, to.z - from.z);
    const steps = Math.max(1, Math.round(span / step));
    let previous = field.baseHeightAt(from.x, from.z);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const px = from.x + (to.x - from.x) * t;
      const pz = from.z + (to.z - from.z) * t;
      const h = field.baseHeightAt(px, pz);
      steepest = Math.max(steepest, Math.abs(h - previous) / (span / steps));
      previous = h;
      if (h < WATER_LEVEL) wet++;
      samples++;
    }
  };

  // The main street, and the two back streets that run parallel to it.
  for (const dz of [0, CROSS_REACH, -CROSS_REACH]) {
    along(
      { x: x - MAIN_STREET_HALF, z: z + dz },
      { x: x + MAIN_STREET_HALF, z: z + dz },
      BLOCK / 2,
    );
  }
  // The cross streets between them.
  for (let d = -MAIN_STREET_HALF + BLOCK; d < MAIN_STREET_HALF; d += BLOCK) {
    along({ x: x + d, z: z - CROSS_REACH }, { x: x + d, z: z + CROSS_REACH }, 60);
  }
  // The station approach roads, which climb out of the town to the railway --
  // the longest uninterrupted run in the layout, and the one most likely to
  // find a bank.
  for (const side of [-1, 1] as const) {
    const at = x + side * STATION_OFFSET;
    along({ x: at, z: z + CROSS_REACH }, { x: at, z: z + RAIL_OFFSET }, 70);
  }
  // The railway itself, which is laid to a far tighter gradient than a street.
  along({ x: x - RAIL_HALF, z: z + RAIL_OFFSET }, { x: x + RAIL_HALF, z: z + RAIL_OFFSET }, 80);

  // A town centre standing in the lake loses. A little water nearby is not
  // penalised out of existence: a fishery needs a shore, and the valley is
  // where the fertile ground is.
  return steepest * 100 + (wet / Math.max(1, samples)) * 40;
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
  //
  // Its waypoints land on every half block, which is what puts a node exactly
  // where each cross street starts: `draw` joins to an existing node within
  // three metres, and nothing else would join these two roads (a cross street
  // *begins* on the main street, so the automatic-crossing pass never sees an
  // intersection to resolve). Derived from BLOCK rather than written as a
  // number, because with the two out of step the side streets are laid
  // alongside the main street without touching it, and no car can leave the
  // block.
  const main: Waypoint[] = [];
  for (let d = -MAIN_STREET_HALF; d <= MAIN_STREET_HALF; d += BLOCK / 2) {
    main.push({ x: site.x + d, z: site.z });
  }
  draw(net, field, 'road_medium', smoothProfile(field, main, 'road_medium', { grade: 0.05 }), {
    straight: true,
  });

  // Cross streets, north and south of it. Drawn as two separate runs from the
  // main street outward so each one joins it at a proper junction.
  const crossEnds: { north: Vector3[]; south: Vector3[] } = { north: [], south: [] };
  for (let d = -MAIN_STREET_HALF + BLOCK; d < MAIN_STREET_HALF; d += BLOCK) {
    for (const side of [1, -1] as const) {
      const points: Waypoint[] = [];
      // Stepped so the last point lands exactly on CROSS_REACH; with a fixed
      // 60 m step the arms stopped at 120 m and the constant said 170.
      const steps = Math.max(1, Math.round(CROSS_REACH / 60));
      for (let i = 0; i <= steps; i++) {
        points.push({ x: site.x + d, z: site.z + side * (CROSS_REACH * i) / steps });
      }
      draw(net, field, 'road_small', smoothProfile(field, points, 'road_small', { grade: 0.07 }), {
        straight: true,
      });
      // The far end of each arm: what the back streets join up, and what the
      // station approach roads reach back to. Taken from the network rather
      // than from the waypoint, so it is the node's real height.
      const tip = points[points.length - 1];
      const node = net.findNodeNear(
        new Vector3(tip.x, tip.y ?? field.baseHeightAt(tip.x, tip.z), tip.z),
        6,
      );
      if (node) crossEnds[side === 1 ? 'north' : 'south'].push(node.pos.clone());
    }
  }

  // Back streets joining the ends of the cross streets, north and south.
  //
  // Not decoration: without them every cross street is a cul-de-sac, and a
  // car that has to turn round at the end of every street spends its life
  // nose to nose with the next one. A grid gives it somewhere to go that is
  // not back the way it came.
  //
  // Laid one block at a time between the existing end nodes, taking each
  // one's height and tangent, rather than as one run on a profile of its own.
  // A profile of its own passes over those junctions a metre or two off their
  // level, and the engine -- rightly -- reads that as a bridge with no
  // headroom under it and files a clearance warning for every block.
  for (const side of [1, -1] as const) {
    const ends = side === 1 ? crossEnds.north : crossEnds.south;
    if (ends.length < 2) continue;
    // Past the outermost cross streets before joining them up. Stopping
    // exactly at the last one leaves a right-angled *corner* there, and the
    // engine cannot shape a junction face that turns through ninety degrees
    // on two approaches -- it says so, and it is right. Carrying on for half
    // a block makes every tip a T instead, which is also what a back street
    // looks like in a town that expects to grow past its own edge.
    for (const [tip, sign] of [[ends[0], -1], [ends[ends.length - 1], 1]] as const) {
      const beyond = new Vector3(tip.x + sign * (BLOCK / 2), 0, tip.z);
      beyond.y = field.baseHeightAt(beyond.x, beyond.z);
      joinAlong(world, tip, beyond);
    }
    for (let i = 1; i < ends.length; i++) joinAlong(world, ends[i - 1], ends[i]);
  }

  if (rail) seedRailway(world, site, crossEnds.north);
  if (zones) paintOpeningZones(world, site);
  return site;
}


/**
 * A street between two points on the ground, joined to whatever is already at
 * either end.
 *
 * The anchors are what matter. Drawing to a bare point next to an existing
 * junction leaves the two a metre apart in height and the engine has to read
 * the result as one road passing over another; anchoring to the node puts the
 * new street *on* the junction, at its level and along its tangent.
 */
function joinAlong(world: CityWorld, from: Vector3, to: Vector3, spacing = 80): void {
  const { net, field } = world;
  const cls = getClass('road_small');
  const startNode = net.findNodeNear(from, 6);
  const endNode = net.findNodeNear(to, 6);
  const span = Math.hypot(to.x - from.x, to.z - from.z);
  if (span < 20) return;
  const steps = Math.max(1, Math.round(span / spacing));
  const points: Waypoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = from.x + (to.x - from.x) * t;
    const z = from.z + (to.z - from.z) * t;
    // The ends take the exact height of what they join; between them the
    // street is interpolated rather than following every hollow, so it does
    // not dive under the ground it is bridging.
    const y = i === 0
      ? from.y
      : i === steps
        ? to.y
        : from.y + (to.y - from.y) * t;
    points.push({ x, y, z });
  }
  draw(net, field, 'road_small', points, {
    straight: true,
    start: startNode ? branchAt(net, startNode, cls) : undefined,
    end: endNode ? branchAt(net, endNode, cls) : undefined,
  });
}

/**
 * An anchor that joins a node without continuing the road already there.
 *
 * `anchorFromNode` is for carrying a road on: at a node with a single branch
 * it hands back that branch's tangent, so the new road leaves along the old
 * one and has to bend round to get where it is going. That is right at the end
 * of a road and wrong at the end of a *street*, where the next one turns off
 * at a right angle -- and the engine says so, reporting a crossing too sharp
 * to shape. The level is still inherited, because a step at the junction would
 * be a real fault; only the direction is left free.
 */
function branchAt(net: CityWorld['net'], node: NetNode, cls: NetworkClass): Anchor {
  const inherited = anchorFromNode(net, node, cls);
  return { pos: inherited.pos, node: node.id, grade: inherited.grade };
}

/**
 * The railway: one line along the north edge of the town, with a station at
 * each end of the built-up area.
 *
 * Single track on purpose. The town starts with the *minimum* railway that is
 * worth running, so that doubling it, or adding a passing loop, is a decision
 * the player gets to make rather than one already made for them.
 */
function seedRailway(world: CityWorld, site: Vector3, northEnds: Vector3[]): void {
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

  // Approach roads. A station you cannot walk to is a station nobody uses, and
  // the town's streets stop well short of the railway -- so each station gets
  // the one road that connects it back to the nearest cross street, ending in
  // a forecourt short of the track rather than crossing it.
  for (const station of stations) {
    if (northEnds.length === 0) break;
    const nearest = northEnds.reduce((best, end) =>
      Math.abs(end.x - station.center.x) < Math.abs(best.x - station.center.x) ? end : best);
    const forecourt = new Vector3(
      station.center.x,
      field.baseHeightAt(station.center.x, railZ - FORECOURT_SETBACK),
      railZ - FORECOURT_SETBACK,
    );
    // Out of the junction squarely first, and only then across to the
    // station. Running straight from the cross street's end to the forecourt
    // arrives at the junction on a slant, and the back street is already
    // there: the engine reads the three of them as a crossing too sharp to
    // shape, and rightly says so.
    const corner = new Vector3(
      nearest.x,
      0,
      nearest.z + (forecourt.z - nearest.z) * 0.45,
    );
    corner.y = field.baseHeightAt(corner.x, corner.z);
    joinAlong(world, nearest, corner, 70);
    joinAlong(world, corner, forecourt, 70);
  }

  // A railway with no service on it is scenery. The town opens with the one
  // line those two stations can support, so that the first thing the player
  // learns about lines is what one *does* rather than how to draw one.
  const line = world.lines.create();
  line.name = '本線';
  for (const station of stations) world.lines.addStop(line.id, station.id);
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
  //
  // Only on ground nothing else claimed, and with a smaller brush. This pass
  // runs last over the same cells as the first one, so painting over what is
  // there turned the town's whole frontage into whatever happened to be under
  // it: on the shipped seed, more forestry than shops and houses combined.
  // It is meant to be an accent on the town, not a replacement for it.
  for (let d = -MAIN_STREET_HALF; d <= MAIN_STREET_HALF; d += 24) {
    for (const side of [1, -1] as const) {
      const x = site.x + d;
      const z = site.z + side * 16;
      if (world.zones.at(x, z) !== null) continue;
      const resource = terrain.resourceAt(x, z);
      const use: ZoneType | null = resource === Resource.Fertile && terrain.nearWater(x, z, 120)
        ? 'farm'
        : resource === Resource.Forest
          ? 'forestry'
          : resource === Resource.Ore
            ? 'mining'
            : null;
      if (use) world.zones.paint(x, z, 10, use);
    }
  }
}
