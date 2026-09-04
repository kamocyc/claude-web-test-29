import { describe, expect, it } from 'vitest';
import { applyCity, captureCity, readSave, writeSave, SAVE_KEY } from '../../city/persistence';
import { seedStartingTown } from '../../city/scenario';
import { CitySimulation, SPEEDS } from '../../city/simulation';
import { CityWorld } from '../../city/world';

/**
 * Saving and loading.
 *
 * The claim being tested is that a loaded city *is* the saved city -- not that
 * it looks similar. So the checks are on identity: the same network, the same
 * people in the same homes, the same money, and, most tellingly, the same
 * future, because two cities run forward from the same save have to agree.
 */
function grownCity(seconds = 60, seed = 20260903) {
  const world = new CityWorld(seed, true);
  seedStartingTown(world);
  world.rebuild();
  const sim = new CitySimulation(world, seed);
  sim.speed = SPEEDS.indexOf(30);
  for (let i = 0; i < seconds * 20; i++) sim.step(1 / 20);
  return { world, sim };
}

function reload(save: ReturnType<typeof captureCity>) {
  const world = new CityWorld(save.seed, true);
  const sim = new CitySimulation(world, save.seed);
  applyCity(world, sim, save);
  return { world, sim };
}

describe('saving a city on the alignment engine', () => {
  it('brings back the same network, down to the numbering', () => {
    const { world, sim } = grownCity();
    const { world: back } = reload(captureCity(world, sim));

    expect(back.net.nodes.size).toBe(world.net.nodes.size);
    expect(back.net.segments.size).toBe(world.net.segments.size);
    expect(back.net.stations.size).toBe(world.net.stations.size);
    for (const [id, segment] of world.net.segments) {
      const copy = back.net.segments.get(id);
      expect(copy).toBeDefined();
      expect(copy!.classId).toBe(segment.classId);
      expect(copy!.a).toBe(segment.a);
      expect(copy!.b).toBe(segment.b);
      expect(copy!.gradeA).toBeCloseTo(segment.gradeA, 9);
    }
    // The derived world came back with it: same plots, same lanes, same line.
    expect(back.lots.length).toBe(world.lots.length);
    expect(back.laneGraph.lanes.length).toBe(world.laneGraph.lanes.length);
    expect(back.result?.lines.length).toBe(world.result?.lines.length);
  });

  it('brings back the people, their homes and their money', () => {
    const { world, sim } = grownCity();
    const { sim: back } = reload(captureCity(world, sim));

    expect(back.citizens.length).toBe(sim.citizens.length);
    expect(back.stats.population).toBe(sim.stats.population);
    expect(back.treasury.balance).toBeCloseTo(sim.treasury.balance, 6);
    expect(back.treasury.spent).toBeCloseTo(sim.treasury.spent, 6);
    expect(back.minutes).toBeCloseTo(sim.minutes, 6);
    for (const [i, citizen] of sim.citizens.entries()) {
      expect(back.citizens[i].name).toBe(citizen.name);
      expect(back.citizens[i].home).toBe(citizen.home);
      expect(back.citizens[i].work).toBe(citizen.work);
      expect(back.citizens[i].hasCar).toBe(citizen.hasCar);
    }
    // Every building found its plot again.
    for (const building of back.buildings) {
      if (!building.alive) continue;
      expect(building.lot).toBeGreaterThanOrEqual(0);
    }
  });

  it('is not charged all over again for the town it already built', () => {
    const { world, sim } = grownCity();
    const save = captureCity(world, sim);
    const { sim: back } = reload(save);
    back.speed = SPEEDS.indexOf(30);
    for (let i = 0; i < 20; i++) back.step(1 / 20);
    expect(back.treasury.spent).toBeCloseTo(sim.treasury.spent, 6);
    expect(back.treasury.balance).toBeCloseTo(sim.treasury.balance, 6);
  });

  it('runs the same future from the same save', () => {
    const { world, sim } = grownCity();
    const save = captureCity(world, sim);

    const run = (): { pop: number; buildings: number; money: number } => {
      const { sim: copy } = reload(save);
      copy.speed = SPEEDS.indexOf(30);
      for (let i = 0; i < 40 * 20; i++) copy.step(1 / 20);
      return {
        pop: copy.stats.population,
        buildings: copy.stats.buildings,
        money: Math.round(copy.treasury.balance),
      };
    };
    expect(run()).toEqual(run());
  });

  it('refuses a save it does not understand rather than half-loading it', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    } as unknown as Storage;

    const { world, sim } = grownCity(20);
    writeSave(captureCity(world, sim), storage);
    expect(readSave(storage)).not.toBeNull();

    store.set(SAVE_KEY, JSON.stringify({ version: 999 }));
    expect(readSave(storage)).toBeNull();
    store.set(SAVE_KEY, 'not json at all');
    expect(readSave(storage)).toBeNull();
  });
});
