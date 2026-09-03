import { describe, expect, it } from 'vitest';
import { idx } from '../core/grid';
import { CitizenState, Zone, type BuildingId } from '../core/types';
import type { Citizen } from '../sim/citizen';
import type { TransitLine } from '../world/transit';
import { BUS_ID_BASE } from '../sim/bus';
import { Simulation } from '../sim/simulation';
import { createBusLine, createLineThrough, reshapeLineThrough } from '../world/lineBuilder';
import { deserialize, serialize } from '../world/persistence';
import { LINE_COLORS, LineMode } from '../world/transit';
import { World } from '../world/world';
import { flatten, powerTown, run } from './helpers';

/**
 * A street with four bus stops and room for four stations beside it.
 *
 * Four rather than two, because every interesting edit -- adding a stop in the
 * middle, dropping one, re-routing round the end -- needs a line that has
 * somewhere to change.
 */
function servedTown(): { world: World; stops: BuildingId[]; stations: BuildingId[] } {
  const w = new World(83);
  w.map.terrain.fill(0);
  flatten(w);

  const y = 30;
  for (let x = 6; x <= 60; x++) w.placeRoad(idx(x, y));
  for (const x of [6, 24, 42, 60]) {
    for (let k = y - 6; k <= y + 6; k++) w.placeRoad(idx(x, k));
  }
  for (let x = 6; x <= 60; x++) w.placeRoad(idx(x, y + 6));

  const stops: BuildingId[] = [];
  for (const x of [8, 26, 44, 58]) {
    const stop = w.placeBusStop(idx(x, y + 1));
    if (stop) stops.push(stop.id);
  }
  const stations: BuildingId[] = [];
  for (const x of [10, 28, 46, 56]) {
    const station = w.placeStation(idx(x, y - 1));
    if (station) stations.push(station.id);
  }

  for (let x = 6; x <= 30; x++) {
    const tile = idx(x, y + 5);
    if (w.adjacentRoad(tile) >= 0) w.paintZone(tile, Zone.ResidentialLow);
  }
  for (let x = 34; x <= 60; x++) {
    const tile = idx(x, y + 5);
    if (w.adjacentRoad(tile) >= 0) w.paintZone(tile, Zone.Commercial);
  }
  powerTown(w, 4);
  return { world: w, stops, stations };
}

describe('editing a line that is already running', () => {
  it('renames and recolours without touching anything else', () => {
    const { world, stops } = servedTown();
    const line = createBusLine(world, stops.slice(0, 3))!;
    const route = line.route.slice();
    const colorBefore = line.color;

    expect(world.renameLine(line.id, '中央循環')).toBe(true);
    expect(line.name).toBe('中央循環');
    // Blank names are refused rather than accepted and then displayed.
    expect(world.renameLine(line.id, '   ')).toBe(false);
    expect(line.name).toBe('中央循環');

    expect(world.cycleLineColor(line.id)).toBe(true);
    expect(line.color).not.toBe(colorBefore);
    expect(LINE_COLORS).toContain(line.color as (typeof LINE_COLORS)[number]);
    expect(line.route).toEqual(route);
  });

  it('adds and removes vehicles, and never removes the last one', () => {
    const { world, stations } = servedTown();
    const { line } = createLineThrough(world, stations.slice(0, 3));
    expect(line).not.toBeNull();
    const sim = new Simulation(world);
    run(sim, 300);

    const started = line!.vehicles.length;
    expect(world.addVehicle(line!.id)).toBe(true);
    expect(line!.vehicles.length).toBe(started + 1);
    // Every vehicle on the line is a live train that belongs to it.
    for (const vid of line!.vehicles) {
      expect(world.trains[vid].line).toBe(line!.id);
    }

    while (world.removeVehicle(line!.id)) {
      expect(line!.vehicles.length).toBeGreaterThanOrEqual(1);
    }
    expect(line!.vehicles.length).toBe(1);
    expect(world.removeVehicle(line!.id)).toBe(false);

    // A train taken off the line stops running rather than carrying on
    // invisibly: it is released, and the sim does not touch it again.
    const retired = world.trains.filter((t) => t.line < 0);
    expect(retired.length).toBeGreaterThan(0);
    for (const t of retired) expect(t.passengers).toHaveLength(0);
    run(sim, 200);
    for (const t of retired) expect(t.line).toBe(-1);
  });

  it('caps how many vehicles one line may work', () => {
    const { world, stops } = servedTown();
    const line = createBusLine(world, stops)!;
    for (let i = 0; i < 20; i++) world.addVehicle(line.id);
    expect(line.vehicles.length).toBe(World.MAX_VEHICLES);
    expect(world.addVehicle(line.id)).toBe(false);
  });

  it('re-routes a bus service through a new stop, keeping its identity', () => {
    const { world, stops } = servedTown();
    const line = createBusLine(world, [stops[0], stops[3]])!;
    world.renameLine(line.id, '快速');
    const sim = new Simulation(world);
    run(sim, 600);
    line.ridership = 42;
    const buses = line.vehicles.length;

    const { line: changed } = reshapeLineThrough(world, line.id, stops);
    expect(changed).toBe(line);
    expect(line.stations).toEqual(stops);
    expect(line.stopAt.length).toBe(stops.length * 2 - 2);
    // The service is the same service: name, colour and figures survive.
    expect(line.name).toBe('快速');
    expect(line.ridership).toBe(42);
    expect(line.vehicles.length).toBe(buses);
    for (const vid of line.vehicles) {
      expect(world.buses[vid - BUS_ID_BASE].line).toBe(line.id);
    }
    // And it still runs.
    run(sim, 600);
    expect(world.lineIsAlive(line)).toBe(true);
  });

  it('lays the missing track when a railway is re-routed through a new station', () => {
    const { world, stations } = servedTown();
    const { line } = createLineThrough(world, [stations[0], stations[1]]);
    expect(line).not.toBeNull();
    const sim = new Simulation(world);
    run(sim, 300);

    const railBefore = world.countTiles(world.map.rail);
    const { line: changed, builtTrack } = reshapeLineThrough(world, line!.id, stations);
    expect(changed).toBe(line);
    expect(builtTrack).toBe(true);
    expect(world.countTiles(world.map.rail)).toBeGreaterThan(railBefore);
    expect(line!.stations).toEqual(stations);
    expect(line!.route.every((t) => world.map.isRail(t))).toBe(true);

    run(sim, 600);
    expect(world.lineIsAlive(line!)).toBe(true);
  });

  it('leaves the old route alone when the new one cannot be built', () => {
    const { world, stops } = servedTown();
    const line = createBusLine(world, [stops[0], stops[1]])!;
    const before = line.route.slice();

    // A stop on an island the roads do not reach.
    for (let x = 90; x <= 100; x++) world.placeRoad(idx(x, 90));
    const marooned = world.placeBusStop(idx(95, 91))!;

    const { line: changed } = reshapeLineThrough(world, line.id, [
      stops[0], stops[1], marooned.id,
    ]);
    expect(changed).toBeNull();
    expect(line.stations).toEqual([stops[0], stops[1]]);
    expect(line.route).toEqual(before);
    expect(world.lineIsAlive(line)).toBe(true);
  });

  it('withdraws a service and releases its vehicles, leaving the stops', () => {
    const { world, stops } = servedTown();
    const line = createBusLine(world, stops)!;
    const sim = new Simulation(world);
    run(sim, 400);

    expect(world.withdrawLine(line.id)).toBe(true);
    expect(world.lineIsAlive(line)).toBe(false);
    for (const bus of world.buses) expect(bus.line).toBe(-1);
    // The shelters are the city's, not the line's.
    for (const id of stops) expect(world.buildings[id].alive).toBe(true);
    // And a second withdrawal is a no-op rather than an error.
    expect(world.withdrawLine(line.id)).toBe(false);
  });

  it('never leaves a rider aboard a vehicle that has stopped running', () => {
    const { world, stops } = servedTown();
    const line = createBusLine(world, stops)!;
    const sim = new Simulation(world);
    run(sim, 600);

    // Put somebody aboard every bus by hand rather than waiting for the city
    // to produce riders: what is being tested is what happens to a passenger
    // when the vehicle under them is withdrawn, and that should not depend on
    // whether this fixture happens to make the bus worth catching. Every bus,
    // because the service drops its emptiest one -- with a single rider it
    // would quietly retire somebody else's empty bus and prove nothing.
    const riders = line.vehicles.map((vid, i) =>
      board(world, line, world.citizens[i], stops[0], stops[3], vid));
    expect(riders.length).toBeGreaterThan(1);
    for (const c of riders) expect(c.state).toBe(CitizenState.Riding);

    // Cutting the service takes their bus out from under them. The line
    // itself survives, so the "your line was withdrawn" rescue does not fire
    // -- and a rider nobody rescues is frozen aboard a vehicle that no longer
    // carries them, for good.
    world.removeVehicle(line.id);
    run(sim, 400);

    // Exactly one of them lost their bus, and that one is not still riding it.
    expect(riders.filter((c) => c.state === CitizenState.Riding).length)
      .toBe(riders.length - 1);
    for (const c of world.citizens) {
      if (c.state !== CitizenState.Riding) continue;
      const vehicle = world.vehicleOn(line, c.boardedVehicle);
      expect(vehicle).toBeDefined();
      expect(vehicle!.passengers).toContain(c.id);
    }
  });

  it('lets go of every rider and waiting passenger when a line is re-routed', () => {
    const { world, stops } = servedTown();
    const line = createBusLine(world, [stops[0], stops[1], stops[3]])!;
    const sim = new Simulation(world);
    run(sim, 600);

    const rider = board(world, line, world.citizens[0], stops[0], stops[3]);
    const waiting = world.citizens[1];
    waiting.state = CitizenState.Waiting;
    waiting.legState = CitizenState.ToWork;
    waiting.ride = {
      line: line.id,
      boardStation: stops[1],
      alightStation: stops[3],
      boardStop: 1,
      alightStop: 2,
    };

    // stops[1] is about to stop being on the line, and every stop index the
    // two of them are holding is about to be renumbered.
    reshapeLineThrough(world, line.id, [stops[0], stops[2], stops[3]]);
    run(sim, 600);

    expect(rider.state).not.toBe(CitizenState.Riding);
    expect(waiting.ride?.boardStation).not.toBe(stops[1]);
    for (const c of [rider, waiting]) {
      // Whatever they are doing now, it is not holding a plan for a shape the
      // line no longer has.
      if (c.ride) expect(line.stations).toContain(c.ride.boardStation);
    }
  });

  it('sends a new train to the next stop it reaches, not back to the terminus', () => {
    const { world, stations } = servedTown();
    const { line } = createLineThrough(world, stations);
    expect(line).not.toBeNull();
    const sim = new Simulation(world);
    run(sim, 400);

    // Bunch the trains at the start, so the widest gap -- and therefore the
    // new train -- lands in the middle of the route rather than in the wrap
    // back to the terminus, where "head for stop 0" happens to be right.
    for (const vid of line!.vehicles) world.trains[vid].s = 1;
    world.addVehicle(line!.id);
    const fresh = world.trains[line!.vehicles[line!.vehicles.length - 1]];
    expect(fresh.s).toBeGreaterThan(line!.stopAt[1]);

    // A train put down in the middle of the route used to be told it was
    // heading for stop 0 -- the far end of a round trip -- so it drove most of
    // a lap past every platform on the way without opening its doors. However
    // far it has to go, it can never be further than the widest gap between
    // two consecutive stops.
    const lap = line!.route.length - 1;
    const ahead = (from: number, to: number): number =>
      (to >= from ? to - from : lap - from + to);
    const toNext = ahead(fresh.s, line!.stopAt[fresh.nextStop]);
    // The stop it is heading for is the first one it comes to: no other stop
    // lies between the train and its target.
    for (const at of line!.stopAt) {
      expect(ahead(fresh.s, at)).toBeGreaterThanOrEqual(toNext - 1e-9);
    }
  });

  it('keeps an edited service across a save', () => {
    const { world, stops } = servedTown();
    const line = createBusLine(world, [stops[0], stops[3]])!;
    const sim = new Simulation(world);
    run(sim, 600);

    world.renameLine(line.id, '環状');
    world.cycleLineColor(line.id);
    world.addVehicle(line.id);
    reshapeLineThrough(world, line.id, stops);
    run(sim, 400);

    // Every edit is state the save has to carry: a load that reverted a
    // re-routed line to the one the player opened would be a load that lied.
    const restored = deserialize(JSON.parse(JSON.stringify(serialize(sim))));
    const after = restored.world.lines[line.id];
    expect(after.name).toBe('環状');
    expect(after.color).toBe(line.color);
    expect(after.stations).toEqual(stops);
    expect(after.vehicles).toEqual(line.vehicles);
    expect(after.route).toEqual(line.route);

    run(restored, 800);
    expect(restored.world.lineIsAlive(after)).toBe(true);
    expect(restored.world.buses.some((b) => b.line === line.id && b.path)).toBe(true);
  });

  it('reuses the slot of a withdrawn line’s vehicles', () => {
    const { world, stops, stations } = servedTown();
    const bus = createBusLine(world, stops)!;
    const buses = world.buses.length;
    world.withdrawLine(bus.id);

    const again = createBusLine(world, stops.slice(0, 2))!;
    expect(again.mode).toBe(LineMode.Road);
    // The withdrawn route's slots were taken rather than new ones appended.
    expect(world.buses.length).toBe(buses);

    const { line: rail } = createLineThrough(world, stations.slice(0, 2));
    const trains = world.trains.length;
    world.withdrawLine(rail!.id);
    const { line: rail2 } = createLineThrough(world, stations.slice(0, 3));
    expect(rail2).not.toBeNull();
    expect(world.trains.length).toBeLessThanOrEqual(trains);
  });
});

/** Put a citizen aboard a vehicle working a line, as boarding would. */
function board(
  world: World,
  line: TransitLine,
  c: Citizen,
  from: BuildingId,
  to: BuildingId,
  vid = line.vehicles[0],
): Citizen {
  const vehicle = world.vehicleOn(line, vid)!;
  c.state = CitizenState.Riding;
  c.legState = CitizenState.ToWork;
  c.ride = {
    line: line.id,
    boardStation: from,
    alightStation: to,
    boardStop: 0,
    alightStop: line.stations.length - 1,
  };
  c.boardedVehicle = vehicle.id;
  vehicle.passengers.push(c.id);
  return c;
}
