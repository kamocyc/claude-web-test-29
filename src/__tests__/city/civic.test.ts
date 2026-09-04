import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { BuildingType } from '../../core/types';
import { CIVIC_KINDS, civicKind, coverage, servicesAt } from '../../city/civic';
import { captureCity, applyCity } from '../../city/persistence';
import { seedStartingTown } from '../../city/scenario';
import { CitySimulation, SPEEDS } from '../../city/simulation';
import { CityWorld } from '../../city/world';
import { isHome } from '../../city/buildings';

/**
 * The buildings the city puts up itself.
 *
 * They are the half of a city sim that zoning cannot do: the player decides
 * where they go, pays for them for ever, and gets back a catchment rather than
 * a product. So what is worth pinning down is that the catchment is real --
 * that it costs money, reaches only so far, and shows up in how people feel
 * about living where they live.
 */
function town(seconds = 45, seed = 20260903) {
  const world = new CityWorld(seed, true);
  seedStartingTown(world);
  world.rebuild();
  const sim = new CitySimulation(world, seed);
  sim.speed = SPEEDS.indexOf(30);
  for (let i = 0; i < seconds * 20; i++) sim.step(1 / 20);
  return { world, sim };
}

/**
 * Somewhere beside a street, which is where these are allowed to go.
 *
 * Taken from a house rather than made up: a house stands on a plot, a plot
 * faces a road, so a few tens of metres off one is reliably within reach of
 * the network without the test having to know the town's layout.
 */
function besideARoad(sim: CitySimulation, nth = 0, away = 30): Vector3 {
  const homes = sim.buildings.filter((b) => b.alive && isHome(b));
  const home = homes[nth % homes.length];
  return new Vector3(home.at.x + away, home.at.y, home.at.z + away);
}

describe('the city’s own buildings', () => {
  it('costs money to put up and money to keep', () => {
    const { sim } = town();
    const before = sim.treasury.balance;
    const kind = civicKind(BuildingType.Hospital)!;
    const upkeepBefore = sim.upkeep;

    expect(sim.place(BuildingType.Hospital, besideARoad(sim))).toBeNull();
    expect(sim.treasury.balance).toBeCloseTo(before - kind.cost, 6);
    expect(sim.upkeep).toBeGreaterThan(upkeepBefore);
  });

  it('refuses a site with no road, and one that is already taken', () => {
    const { world, sim } = town();
    const at = besideARoad(sim);
    expect(sim.place(BuildingType.Park, at)).toBeNull();
    // The same spot twice: the second one has nowhere to stand.
    expect(sim.place(BuildingType.Park, at)).toBe('space');
    // Out in the fields, far from anything the city has built.
    const wilderness = new Vector3(at.x + 2000, 0, at.z + 2000);
    wilderness.y = world.field.baseHeightAt(wilderness.x, wilderness.z);
    expect(sim.place(BuildingType.Park, wilderness)).toBe('road');
  });

  it('will not build what the city cannot pay for', () => {
    const { sim } = town();
    sim.treasury.spend(sim.treasury.balance - 10);
    expect(sim.place(BuildingType.AmusementPark, besideARoad(sim))).toBe('money');
    expect(sim.civic.length).toBe(0);
  });

  it('serves the ground around it and no further', () => {
    const { sim } = town();
    const at = besideARoad(sim);
    expect(sim.place(BuildingType.Hospital, at)).toBeNull();
    const kind = civicKind(BuildingType.Hospital)!;

    expect(coverage(sim.buildings, BuildingType.Hospital, at)).toBe(1);
    const edge = new Vector3(at.x + kind.reach * 0.75, at.y, at.z);
    expect(coverage(sim.buildings, BuildingType.Hospital, edge)).toBeGreaterThan(0);
    expect(coverage(sim.buildings, BuildingType.Hospital, edge)).toBeLessThan(1);
    const away = new Vector3(at.x + kind.reach + 1, at.y, at.z);
    expect(coverage(sim.buildings, BuildingType.Hospital, away)).toBe(0);
    // A hospital is not a police station.
    expect(servicesAt(sim.buildings, at).health).toBe(1);
    expect(servicesAt(sim.buildings, at).safety).toBe(0);
  });

  it('makes the people near it happier than the people far from it', () => {
    const { sim } = town(60);
    const homes = sim.buildings.filter((b) => b.alive && isHome(b));
    expect(homes.length).toBeGreaterThan(2);

    // Everything the city can build, all on the same street corner.
    const at = besideARoad(sim, 0, 40);
    let placed = 0;
    for (const kind of CIVIC_KINDS) {
      const spot = new Vector3(at.x + placed * 90, at.y, at.z);
      if (sim.place(kind.type, spot) === null) placed++;
    }
    expect(placed).toBeGreaterThan(3);

    for (let i = 0; i < 60 * 20; i++) sim.step(1 / 20);

    const near = sim.citizens.filter((c) => {
      const home = sim.buildings[c.home];
      return home?.alive && home.at.distanceTo(at) < 200;
    });
    const far = sim.citizens.filter((c) => {
      const home = sim.buildings[c.home];
      return home?.alive && home.at.distanceTo(at) > 700;
    });
    if (near.length === 0 || far.length === 0) return;
    const mean = (xs: typeof near): number =>
      xs.reduce((n, c) => n + c.happiness, 0) / xs.length;
    expect(mean(near)).toBeGreaterThan(mean(far));
  });

  it('survives being saved and opened again', () => {
    const { world, sim } = town();
    expect(sim.place(BuildingType.Park, besideARoad(sim))).toBeNull();
    expect(sim.place(BuildingType.School, besideARoad(sim, 6))).toBeNull();
    const save = captureCity(world, sim);

    const back = new CityWorld(save.seed, true);
    const backSim = new CitySimulation(back, save.seed);
    applyCity(back, backSim, save);

    expect(backSim.civic.length).toBe(sim.civic.length);
    for (const [i, building] of sim.civic.entries()) {
      expect(backSim.civic[i].type).toBe(building.type);
      expect(backSim.civic[i].at.distanceTo(building.at)).toBeLessThan(0.001);
    }
    // A civic building is never matched back to a plot, and never demolished
    // because the streets around it were re-laid.
    back.rebuild();
    for (let i = 0; i < 20; i++) backSim.step(1 / 20);
    expect(backSim.civic.length).toBe(sim.civic.length);
  });
});
