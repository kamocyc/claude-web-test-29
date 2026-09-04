import { describe, expect, it } from 'vitest';
import { ZONE_TYPES } from '../../track/network/zoning';
import { seedStartingTown } from '../../city/scenario';
import { CityWorld } from '../../city/world';

/**
 * The opening town, built the way the game builds it.
 *
 * This is the new world's version of the tile city's new-game test, and it
 * exists for the same reason: every other test starts from a fixture shaped to
 * measure one thing, so nobody would notice that the town the player actually
 * starts in fails to lay its own streets.
 */
function openingTown() {
  const world = new CityWorld(20260903, true);
  seedStartingTown(world);
  const result = world.rebuild();
  return { world, result };
}

describe('the opening town', () => {
  it('lays its streets and its railway as real alignments', () => {
    const { world, result } = openingTown();

    const segments = [...world.net.segments.values()];
    const roads = segments.filter((s) => world.net.classOf(s).kind === 'road');
    const rails = segments.filter((s) => world.net.classOf(s).kind === 'rail');
    expect(roads.length).toBeGreaterThan(10);
    expect(rails.length).toBeGreaterThan(2);

    // The streets meet: cross streets join the main street at junctions rather
    // than crossing it as two unconnected lines.
    expect(result.stats.intersections).toBeGreaterThan(4);
    // ...and the whole road network is one thing you can drive around.
    expect(result.stats.roadNetworks).toBe(1);
    // Two stations, on the railway rather than beside it.
    expect(result.stats.stations).toBe(2);
    expect(result.stats.railNetworks).toBe(1);
  });

  it('follows the ground rather than flattening it', () => {
    const { world } = openingTown();
    // Roads take a gentler grade than the ground they cross, so the engine has
    // to cut, fill or bridge -- which is the whole reason the alignment model
    // replaced the tile map. Somewhere along the main street the road and the
    // untouched ground must differ.
    let biggest = 0;
    for (const segment of world.net.segments.values()) {
      const alignment = world.net.alignmentOf(segment.id);
      for (let s = 0; s <= alignment.length; s += 8) {
        const at = alignment.sampleAt(s).pos;
        biggest = Math.max(biggest, Math.abs(at.y - world.field.baseHeightAt(at.x, at.z)));
      }
    }
    expect(biggest).toBeGreaterThan(1);
  });

  it('paints uses that turn into plots along the streets', () => {
    const { world, result } = openingTown();
    expect(world.zones.size).toBeGreaterThan(100);
    expect(result.lots.length).toBeGreaterThan(20);

    // Every plot belongs to a road, sits beside it, and knows which way is
    // away from it -- everything a building needs to be placed and reached.
    for (const lot of result.lots) {
      expect(world.net.segments.has(lot.segment)).toBe(true);
      expect(ZONE_TYPES).toContain(lot.zone);
      expect(lot.halfFrontage).toBeGreaterThan(0);
      expect(lot.outward.length()).toBeCloseTo(1, 3);
    }

    // The town has somewhere to live and somewhere to work, which is the
    // minimum for anybody to have a reason to travel.
    const kinds = new Set(result.lots.map((lot) => lot.zone));
    expect(kinds.has('residential')).toBe(true);
    expect(kinds.size).toBeGreaterThan(2);
  });

  it('builds the same town twice from the same seed', () => {
    const a = openingTown();
    const b = openingTown();
    expect(b.result.stats).toEqual(a.result.stats);
    expect(b.result.lots.map((lot) => [lot.center.x, lot.center.z, lot.zone]))
      .toEqual(a.result.lots.map((lot) => [lot.center.x, lot.center.z, lot.zone]));
  });

  it('reports nothing at all from the engine that laid it', () => {
    const { result } = openingTown();
    // Not just "no errors". The first thing a player sees must not be a list
    // of complaints the game made about its own town: a street laid up a
    // slope it cannot climb, or a railway joint the engine calls a kink. Both
    // happened, and both are why the town now searches for a flat site and
    // puts its plain track on the station's own centre line.
    expect(result.warnings.map((w) => w.message)).toEqual([]);
  });

  it('sits on ground its own streets can climb', () => {
    const { world } = openingTown();
    for (const segment of world.net.segments.values()) {
      const cls = world.net.classOf(segment);
      const grade = world.net.alignmentOf(segment.id).vertical.maxGrade();
      expect(Math.abs(grade)).toBeLessThanOrEqual(cls.maxGrade + 1e-6);
    }
  });

  it('lays a clean town on any ground, not just the one it was tuned on', () => {
    // The site search is the thing under test. It used to score a rectangle by
    // its average slope, which happily picked ground that was flat on average
    // with one bank across the middle -- and the town then filed 32% gradient
    // warnings against itself on the first screen the player sees. It now
    // scores the streets it is actually going to lay, including the climb out
    // to the railway, so this holds on seeds nobody tuned for.
    for (const seed of [1, 7, 42, 99, 555, 1234, 20260812, 20260903, 424242, 777777]) {
      const world = new CityWorld(seed, true);
      seedStartingTown(world);
      const result = world.rebuild();
      expect(
        result.warnings.map((w) => w.message),
        `seed ${seed}`,
      ).toEqual([]);
      // ...and every street reaches every other one. The cross streets meet
      // the main street only because a node is already there, so a layout
      // whose spacings drift apart lays them side by side without touching.
      expect(result.stats.roadNetworks, `seed ${seed}`).toBe(1);
    }
  });
});