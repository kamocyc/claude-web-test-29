import { Vector3 } from 'three';
import { draw, smoothProfile, type Waypoint } from '../track/app/sketch';
import { getClass } from '../track/network/classes';
import { anchorFromNode } from '../track/network/editing';
import type { NetNode } from '../track/network/network';
import type { ZoneType } from '../track/network/zoning';
import type { CityWorld } from './world';
import { Resource } from './terrain';

/**
 * The town the game opens on.
 *
 * The tile city started from a grid because a grid was all a tile map could
 * be. This one is laid with the same tool the player has: streets are drawn as
 * alignments that follow the ground, so the opening town already shows what
 * the city is now made of -- a road that bends around a hill, a railway on a
 * gentler gradient than the street beside it, a bridge where the valley
 * crosses.
 *
 * The shape is the same argument the tile town made, though. Housing on one
 * side, work on the other, and **one street between them**: a town with spare
 * capacity everywhere never jams, and the interesting decisions only start
 * once the connection between where people live and where they work is the
 * scarce thing.
 */

/** Where the opening town sits. Chosen for flat-ish ground near the valley. */
export const TOWN_CENTRE = new Vector3(0, 0, 0);

/** Where the camera looks when a new game opens. */
export const STARTING_VIEW = TOWN_CENTRE;

const MAIN_STREET_Z = 0;
const MAIN_STREET_FROM = -560;
const MAIN_STREET_TO = 560;
/** Cross streets every this many metres, which sets the block size. */
const BLOCK = 140;
/** How far the cross streets run either side of the main street. */
const CROSS_REACH = 170;
/** The railway runs parallel to the main street, this far north of it. */
const RAIL_Z = 330;
const RAIL_FROM = -520;
const RAIL_TO = 520;
const STATION_LENGTH = 120;
const STATIONS = [
  { name: '西町', x: -360 },
  { name: '東町', x: 360 },
] as const;

export interface ScenarioOptions {
  /** Lay the railway and its two stations. Off in tests that only want roads. */
  rail?: boolean;
  /** Paint the opening zones. */
  zones?: boolean;
}

/** Build the opening town into an empty world. */
export function seedStartingTown(world: CityWorld, options: ScenarioOptions = {}): void {
  const { net, field } = world;
  const rail = options.rail ?? true;
  const zones = options.zones ?? true;

  // The main street. Its profile is smoothed to a gentler grade than the
  // ground so that the engine has something to cut, fill and bridge -- a road
  // that simply follows every hollow is a road nobody had to think about.
  const main: Waypoint[] = [];
  for (let x = MAIN_STREET_FROM; x <= MAIN_STREET_TO; x += 70) main.push({ x, z: MAIN_STREET_Z });
  draw(net, field, 'road_medium', smoothProfile(field, main, 'road_medium', { grade: 0.05 }), {
    straight: true,
  });

  // Cross streets, north and south of it. Drawn as two separate runs from the
  // main street outward so each one joins it at a proper junction.
  for (let x = MAIN_STREET_FROM + BLOCK; x < MAIN_STREET_TO; x += BLOCK) {
    for (const side of [1, -1] as const) {
      const points: Waypoint[] = [];
      for (let d = 0; d <= CROSS_REACH; d += 60) {
        points.push({ x, z: MAIN_STREET_Z + side * d });
      }
      draw(net, field, 'road_small', smoothProfile(field, points, 'road_small', { grade: 0.07 }), {
        straight: true,
      });
    }
  }

  if (rail) seedRailway(world);
  if (zones) paintOpeningZones(world);
}

/**
 * The railway: one line along the north edge of the town, with a station at
 * each end of the built-up area.
 *
 * Single track on purpose. The town starts with the *minimum* railway that is
 * worth running, so that doubling it, or adding a passing loop, is a decision
 * the player gets to make rather than one already made for them.
 */
function seedRailway(world: CityWorld): void {
  const { net, field } = world;

  // The line's vertical profile is worked out *before* anything is laid, so
  // the stations can be put at the height the railway will actually be at.
  // Placing them on the bare ground and then drawing up to them asks the
  // approach to climb several metres in no distance at all, and the line ends
  // up in three disconnected pieces -- which is exactly what happened first.
  const spine: Waypoint[] = [];
  for (let x = RAIL_FROM; x <= RAIL_TO; x += 40) spine.push({ x, z: RAIL_Z });
  const profile = smoothProfile(field, spine, 'rail_single', { grade: 0.02 });
  const railYAt = (x: number): number => {
    const t = (x - RAIL_FROM) / (RAIL_TO - RAIL_FROM);
    const at = t * (profile.length - 1);
    const i = Math.max(0, Math.min(profile.length - 2, Math.floor(at)));
    const f = at - i;
    const y0 = profile[i].y ?? field.baseHeightAt(profile[i].x, RAIL_Z);
    const y1 = profile[i + 1].y ?? field.baseHeightAt(profile[i + 1].x, RAIL_Z);
    return y0 + (y1 - y0) * f;
  };

  // Heading 0 puts the station tracks along +X, which is the way this railway
  // runs. (Heading is the track direction, not the platform's.)
  const stations = STATIONS.map(({ name, x }) => net.addStation({
    name,
    center: new Vector3(x, railYAt(x), RAIL_Z),
    heading: 0,
    length: STATION_LENGTH,
    trackCount: 1,
    platformCount: 1,
    elevated: false,
  }));

  const cls = getClass('rail_single');
  /** The two ends of a station's single track, west first. */
  const endsOf = (station: (typeof stations)[number]): [NetNode, NetNode] => {
    const seg = net.getSegment(station.tracks[0].segment);
    const nodes = [net.getNode(seg.a), net.getNode(seg.b)];
    return nodes[0].pos.x <= nodes[1].pos.x ? [nodes[0], nodes[1]] : [nodes[1], nodes[0]];
  };

  const [westA, eastA] = endsOf(stations[0]);
  const [westB, eastB] = endsOf(stations[1]);

  /**
   * One run of plain track between two points, at the line's own profile.
   *
   * Where an end is a station track, the anchor comes from its node so the
   * new track picks up its position, tangent and level and the joint is
   * continuous rather than a kink at the platform end.
   */
  const run = (from: Vector3 | NetNode, to: Vector3 | NetNode): void => {
    const a = 'pos' in from ? from.pos : from;
    const b = 'pos' in to ? to.pos : to;
    const span = b.x - a.x;
    if (Math.abs(span) < 40) return;
    const steps = Math.max(1, Math.round(Math.abs(span) / 80));
    const points: Waypoint[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = a.x + span * t;
      // The ends take the exact height of what they are joining, so the
      // approach meets the platform level rather than aiming near it.
      const y = i === 0 ? a.y : i === steps ? b.y : railYAt(x);
      points.push({ x, z: RAIL_Z, y });
    }
    draw(net, field, 'rail_single', points, {
      straight: true,
      start: 'pos' in from ? anchorFromNode(net, from, cls) : undefined,
      end: 'pos' in to ? anchorFromNode(net, to, cls) : undefined,
    });
  };

  run(new Vector3(RAIL_FROM, railYAt(RAIL_FROM), RAIL_Z), westA);
  run(eastA, westB);
  run(eastB, new Vector3(RAIL_TO, railYAt(RAIL_TO), RAIL_Z));
}

/**
 * The opening zones: housing in the west, shops and offices in the middle,
 * industry in the east, and whatever primary industry the ground allows.
 *
 * Painted along the streets rather than over a rectangle, because that is what
 * zoning is now: a use painted on the ground, which the engine turns into
 * plots wherever a road runs past it.
 */
function paintOpeningZones(world: CityWorld): void {
  const { terrain } = world;
  const paint = (x: number, z: number, zone: ZoneType): void => {
    world.zones.paint(x, z, 26, zone);
  };

  for (let x = MAIN_STREET_FROM + 40; x <= MAIN_STREET_TO - 40; x += 24) {
    const use: ZoneType = x < -180 ? 'residential' : x < 180 ? 'commercial' : 'industrial';
    for (const side of [1, -1] as const) {
      paint(x, MAIN_STREET_Z + side * 16, use);
    }
  }

  // Along the cross streets: housing behind the housing, offices behind the
  // shops. The second row is what gives the town somewhere to grow into.
  for (let x = MAIN_STREET_FROM + BLOCK; x < MAIN_STREET_TO; x += BLOCK) {
    for (let d = 40; d <= CROSS_REACH - 20; d += 24) {
      for (const side of [1, -1] as const) {
        const z = MAIN_STREET_Z + side * d;
        const use: ZoneType = x < -180 ? 'residential' : x < 180 ? 'office' : 'industrial';
        paint(x + 16, z, use);
        paint(x - 16, z, use);
      }
    }
  }

  // Primary industry, where the ground actually supports it. Painted only
  // where a street already runs past, so the opening town has one of whatever
  // it can have rather than an outpost nobody can reach.
  for (let x = MAIN_STREET_FROM; x <= MAIN_STREET_TO; x += 24) {
    for (const side of [1, -1] as const) {
      const z = MAIN_STREET_Z + side * 16;
      const resource = terrain.resourceAt(x, z);
      if (resource === Resource.Fertile && terrain.nearWater(x, z, 80)) paint(x, z, 'farm');
      else if (resource === Resource.Forest) paint(x, z, 'forestry');
      else if (resource === Resource.Ore) paint(x, z, 'mining');
    }
  }
}
