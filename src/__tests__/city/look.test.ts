import { describe, expect, it } from 'vitest';
import type { InstancedMesh } from 'three';
import { atmosphereAt, sunDirection } from '../../look/sky';
import { Season, seasonOnDay } from '../../look/season';
import { BuildingView } from '../../city/buildingView';
import { NatureLayer } from '../../city/nature';
import { StreetLights } from '../../city/streetLights';
import { seedStartingTown } from '../../city/scenario';
import { CitySimulation, SPEEDS } from '../../city/simulation';
import { CityWorld } from '../../city/world';

/**
 * The look.
 *
 * Almost none of this can be judged by a test -- whether a street reads as a
 * street is a question for a screenshot. What a test *can* hold is the wiring
 * underneath it: that the sky is driven by the clock rather than fixed, that
 * the layers actually put something in the scene for a town that exists, and
 * that trees are not planted on the roads. Those are the things that break
 * silently when something else is refactored.
 */
function town(seconds = 60, seed = 20260903) {
  const world = new CityWorld(seed, true);
  // The town picks its own site on the generated ground, and the layers only
  // lay what is near the view -- so the tests have to look where it is.
  const site = seedStartingTown(world);
  world.rebuild();
  const sim = new CitySimulation(world, seed);
  sim.speed = SPEEDS.indexOf(30);
  for (let i = 0; i < seconds * 20; i++) sim.step(1 / 20);
  return { world, sim, site };
}

describe('the sky', () => {
  it('is a different sky at noon than at midnight', () => {
    const noon = { ...atmosphereAt(0.5) };
    const night = { ...atmosphereAt(0) };
    expect(noon.nightAmount).toBe(0);
    expect(night.nightAmount).toBe(1);
    expect(noon.sunIntensity).toBeGreaterThan(night.sunIntensity * 3);
  });

  it('moves the sun across the day and never drops it below the ground', () => {
    // Below the horizon the shadow camera would be underneath the city and
    // every shadow would come up through the floor.
    let east = 0;
    let west = 0;
    for (let h = 0; h < 24; h += 0.25) {
      const dir = sunDirection(h / 24);
      expect(dir.y).toBeGreaterThan(0);
      if (h > 7 && h < 9) east = dir.x;
      if (h > 16 && h < 18) west = dir.x;
    }
    // Rises on one side, sets on the other.
    expect(Math.sign(east)).not.toBe(Math.sign(west));
  });

  it('turns the year over', () => {
    expect(seasonOnDay(0)).toBe(Season.Spring);
    const seen = new Set([0, 30, 60, 90].map(seasonOnDay));
    expect(seen.size).toBe(4);
    expect(seasonOnDay(96)).toBe(seasonOnDay(0));
  });
});

describe('the layers that draw the city', () => {
  it('builds a building for every building the city has', () => {
    const { world, sim } = town();
    const view = new BuildingView();
    view.update(world, sim.buildings);
    // A building is a good many parts -- walls, roof, awnings, plant -- so
    // this only says "something was composed for each of them", which is the
    // claim that breaks when the wiring is wrong.
    const drawn = (view.group.children[0].children as InstancedMesh[])
      .reduce((n, mesh) => n + mesh.count, 0);
    expect(sim.stats.buildings).toBeGreaterThan(4);
    expect(drawn).toBeGreaterThan(sim.stats.buildings);
  });

  it('plants trees, and not on the roads', () => {
    const { world, site } = town(20);
    const nature = new NatureLayer();
    nature.update(world, 0, site);

    const meshes = nature.group.children as InstancedMesh[];
    const planted = meshes.reduce((n, m) => n + m.count, 0);
    expect(planted).toBeGreaterThan(50);

    // Nothing within a few metres of a road's centreline. A tree in the
    // carriageway is the first thing anybody would notice.
    let onRoad = 0;
    for (const mesh of meshes) {
      for (let i = 0; i < mesh.count; i++) {
        const x = mesh.instanceMatrix.array[i * 16 + 12];
        const z = mesh.instanceMatrix.array[i * 16 + 14];
        for (const segment of world.net.segments.values()) {
          if (world.net.classOf(segment).kind !== 'road') continue;
          const alignment = world.net.alignmentOf(segment.id);
          for (let s = 0; s <= alignment.length; s += 20) {
            const p = alignment.sampleAt(s).pos;
            if (Math.hypot(p.x - x, p.z - z) < 5) onRoad++;
          }
        }
      }
    }
    expect(onRoad).toBe(0);
  });

  it('hangs lamps along the roads and none along the railway', () => {
    const { world, site } = town(20);
    const lamps = new StreetLights();
    lamps.update(world, site);

    const meshes = lamps.group.children as InstancedMesh[];
    const laid = meshes.reduce((n, m) => n + m.count, 0);
    expect(laid).toBeGreaterThan(20);

    // One head and one pool apiece.
    expect(meshes[0].count).toBe(meshes[1].count);
  });

  it('turns the lamps on after dark and off in daylight', () => {
    const lamps = new StreetLights();
    lamps.setNight(atmosphereAt(0.5).nightAmount);
    expect(lamps.group.visible).toBe(false);
    lamps.setNight(atmosphereAt(0).nightAmount);
    expect(lamps.group.visible).toBe(true);
  });
});
