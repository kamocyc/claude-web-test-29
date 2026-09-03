import { describe, expect, it } from 'vitest';
import {
  STATION_WALK_RADIUS,
  TRAIN_CAPACITY,
  TRAIN_FREE_SPEED,
  TRAINS_PER_LINE,
} from '../config';
import { idx } from '../core/grid';
import { BuildingType, type BuildingId } from '../core/types';
import { createLine, layoutRoute } from '../world/lineBuilder';
import { expectedWaitTicks, lapTicks, rideTicks, stopsFor } from '../world/transit';
import { World } from '../world/world';

function flatWorld(): World {
  const w = new World(5);
  w.map.terrain.fill(0);
  return w;
}

/**
 * A straight railway along y=20 with a parallel service road at y=18, leaving
 * y=19 as the strip of tiles that touch both -- where stations can go.
 */
function railCorridor(w: World, xs: number[]): BuildingId[] {
  for (let x = 2; x <= 60; x++) {
    w.placeRail(idx(x, 20));
    w.placeRoad(idx(x, 18));
  }
  const stations: BuildingId[] = [];
  for (const x of xs) {
    const b = w.placeStation(idx(x, 19));
    if (b) stations.push(b.id);
  }
  return stations;
}

describe('stations', () => {
  it('needs a road to sit on, and adopts the track beside it', () => {
    const w = flatWorld();
    for (let x = 2; x <= 10; x++) w.placeRail(idx(x, 20));

    // Track but no road: passengers could not reach it, so not a station.
    expect(w.placeStation(idx(5, 19))).toBeNull();

    w.placeRoad(idx(5, 18));
    const b = w.placeStation(idx(5, 19));
    expect(b).not.toBeNull();
    expect(b!.type).toBe(BuildingType.Station);
    expect(b!.platform).toBe(idx(5, 20));
    expect(b!.accessRoad).toBe(idx(5, 18));
  });

  it('accepts a tile with only a road, and waits for its platform', () => {
    const w = flatWorld();
    for (let x = 2; x <= 10; x++) w.placeRoad(idx(x, 18));

    // Siting comes first; the line tool lays the track that serves it.
    const b = w.placeStation(idx(5, 19));
    expect(b).not.toBeNull();
    expect(b!.platform).toBe(-1);
  });

  it('does not count as a home or a workplace', () => {
    const w = flatWorld();
    railCorridor(w, [10]);
    expect(w.jobCount).toBe(0);
    // Stations legitimately have zero capacity, and must still be alive.
    expect(w.stations).toHaveLength(1);
    expect(w.isAlive(w.stations[0])).toBe(true);
  });
});

describe('line layout', () => {
  it('builds a round trip that starts and ends on the same tile', () => {
    const w = flatWorld();
    const stations = railCorridor(w, [10, 25, 40]);
    const layout = layoutRoute(w, stations)!;

    expect(layout).not.toBeNull();
    expect(layout.route[0]).toBe(layout.route[layout.route.length - 1]);
    // Out and back over 30 tiles of track.
    expect(layout.route.length - 1).toBe(60);
  });

  it('stops at every station once each way, without repeating the origin', () => {
    const w = flatWorld();
    const stations = railCorridor(w, [10, 25, 40]);
    const line = createLine(w, stations)!;

    // A,B,C,B -- the wrap back to index 0 is the return to A.
    expect(line.stopAt).toHaveLength(4);
    expect(line.stopStation).toEqual([stations[0], stations[1], stations[2], stations[1]]);
  });

  it('keeps stop positions strictly increasing along the route', () => {
    const w = flatWorld();
    const line = createLine(w, railCorridor(w, [5, 15, 30, 50]))!;
    for (let i = 1; i < line.stopAt.length; i++) {
      expect(line.stopAt[i]).toBeGreaterThan(line.stopAt[i - 1]);
    }
    // Every stop maps back to the tile of the station it serves.
    line.stopAt.forEach((at, i) => {
      const station = w.buildings[line.stopStation[i]];
      expect(line.route[at]).toBe(station.platform);
    });
  });

  it('refuses stations the track does not connect', () => {
    const w = flatWorld();
    const stations = railCorridor(w, [10, 40]);
    w.bulldoze(idx(25, 20)); // sever the line between them
    expect(layoutRoute(w, stations)).toBeNull();
    expect(createLine(w, stations)).toBeNull();
  });

  it('refuses fewer than two stations', () => {
    const w = flatWorld();
    expect(layoutRoute(w, railCorridor(w, [10]))).toBeNull();
  });

  it('spaces its trains evenly around the route', () => {
    const w = flatWorld();
    const line = createLine(w, railCorridor(w, [10, 40]))!;
    expect(line.vehicles).toHaveLength(TRAINS_PER_LINE);

    const positions = line.vehicles.map((id) => w.trains[id].s).sort((a, b) => a - b);
    const lap = line.route.length - 1;
    positions.forEach((s, i) => {
      expect(s).toBeCloseTo((lap * i) / TRAINS_PER_LINE);
    });
  });
});

describe('ride time', () => {
  it('measures forward along the route and wraps', () => {
    const w = flatWorld();
    const line = createLine(w, railCorridor(w, [10, 25, 40]))!;
    const forward = rideTicks(line, 0, 1);
    const wrapped = rideTicks(line, 3, 0);
    expect(forward).toBeGreaterThan(0);
    expect(wrapped).toBeGreaterThan(0);
    // A full lap of stops adds up to the whole round trip.
    const total = [0, 1, 2, 3].reduce(
      (sum, i) => sum + rideTicks(line, i, (i + 1) % 4),
      0,
    );
    expect(total).toBeCloseTo((line.route.length - 1) / TRAIN_FREE_SPEED);
  });

  it('finds both stop occurrences of a mid-line station', () => {
    const w = flatWorld();
    const stations = railCorridor(w, [10, 25, 40]);
    const line = createLine(w, stations)!;
    // The middle station is served in both directions.
    expect(stopsFor(line, stations[1])).toHaveLength(2);
    expect(stopsFor(line, stations[0])).toHaveLength(1);
  });

  it('shortens the wait in proportion to the number of trains', () => {
    const w = flatWorld();
    const line = createLine(w, railCorridor(w, [10, 40]))!;
    const full = expectedWaitTicks(line);

    line.vehicles = line.vehicles.slice(0, 1);
    const single = expectedWaitTicks(line);
    expect(full).toBeCloseTo(single / TRAINS_PER_LINE);

    // Half a headway on a single-train line is half a lap.
    expect(single).toBeCloseTo(lapTicks(line) / 2);
    // And a lap is more than just the running time, because of dwell.
    expect(lapTicks(line)).toBeGreaterThan((line.route.length - 1) / TRAIN_FREE_SPEED);
  });
});

describe('demolition', () => {
  it('drops a line when its track is cut', () => {
    const w = flatWorld();
    const line = createLine(w, railCorridor(w, [10, 40]))!;
    expect(w.activeLines).toHaveLength(1);

    w.bulldoze(idx(25, 20));
    expect(w.lineIsAlive(line)).toBe(false);
    expect(w.activeLines).toHaveLength(0);
  });

  it('drops a line when one of its stations is demolished', () => {
    const w = flatWorld();
    const stations = railCorridor(w, [10, 25, 40]);
    const line = createLine(w, stations)!;

    w.bulldoze(w.buildings[stations[1]].tile);
    expect(w.lineIsAlive(line)).toBe(false);
  });
});

describe('config sanity', () => {
  it('keeps trains under the tile-stepping ceiling', () => {
    // Above 0.5 tiles/tick a train could skip a tile between samples, which
    // would break route bookkeeping the same way it would for cars.
    expect(TRAIN_FREE_SPEED).toBeLessThan(0.5);
  });

  it('gives a station a walkable catchment and a finite train', () => {
    expect(STATION_WALK_RADIUS).toBeGreaterThan(0);
    expect(TRAIN_CAPACITY).toBeGreaterThan(0);
  });
});
