import { Vector3 } from 'three';
import { MAP_SIZE } from '../track/core/units';
import type { NetSegment } from '../track/network/network';
import { ZONE_COLORS } from '../track/build/buildings';
import type { CityBuilding } from './buildings';
import { civicKind } from './civic';
import { civicColor } from './civicView';
import type { CityWorld } from './world';
import { WATER_LEVEL } from './terrain';

/**
 * The plan view: the same city, from straight above, drawn on a 2D canvas.
 *
 * Kept for two reasons that survive the move to 3D. A plan is the view you lay
 * a road *network* in -- you can see where two streets do and do not meet
 * without orbiting -- and it is the view the city's data overlays belong in,
 * because a wash of colour over the ground reads as data rather than as
 * something built. It draws from the very same world the 3D scene does, so the
 * two can never show different cities.
 */

/** How far apart the terrain is sampled when shading it [m]. */
const TERRAIN_STEP = 16;

export interface PlanCamera {
  /** Centre of the view, in world metres. */
  x: number;
  z: number;
  /** Screen pixels per world metre. */
  zoom: number;
}

export interface PlanOptions {
  /** The city's own buildings, which do not stand on the engine's plots. */
  civic?: readonly CityBuilding[];
  /** Wash in the catchments, because a facility is being placed right now. */
  showReach?: boolean;
  /** The alignment being previewed by the build tool, if any. */
  preview?: Vector3[] | null;
  /** A point to ring, because something asked to be shown. */
  focus?: Vector3 | null;
  /** Where the cursor is on the ground. */
  cursor?: Vector3 | null;
  /** Draw the zoning grid (while the zone tool is in hand). */
  showZones?: boolean;
}

const COLORS = {
  background: '#0f1519',
  water: '#2a5f92',
  road: '#4a5058',
  roadEdge: '#6b7381',
  rail: '#463c33',
  railTie: '#8b7a63',
  station: '#c58fe0',
  vehicle: '#f0e6c8',
  train: '#7fd6ff',
  preview: 'rgba(255, 201, 74, 0.85)',
  focus: '#ffc94a',
  cursor: 'rgba(255,255,255,0.35)',
} as const;

export class PlanView {
  readonly camera: PlanCamera = { x: 0, z: 0, zoom: 0.45 };

  private width = 0;
  private height = 0;

  constructor(private readonly ctx: CanvasRenderingContext2D) {}

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  /** World metres -> screen pixels. */
  toScreen(x: number, z: number): { x: number; y: number } {
    return {
      x: (x - this.camera.x) * this.camera.zoom + this.width / 2,
      y: (z - this.camera.z) * this.camera.zoom + this.height / 2,
    };
  }

  /** Screen pixels -> world metres (the ground the cursor is over). */
  toWorld(px: number, py: number): { x: number; z: number } {
    return {
      x: (px - this.width / 2) / this.camera.zoom + this.camera.x,
      z: (py - this.height / 2) / this.camera.zoom + this.camera.z,
    };
  }

  panByPixels(dx: number, dy: number): void {
    this.camera.x -= dx / this.camera.zoom;
    this.camera.z -= dy / this.camera.zoom;
    this.clamp();
  }

  zoomAt(px: number, py: number, factor: number): void {
    const before = this.toWorld(px, py);
    this.camera.zoom = Math.min(6, Math.max(0.08, this.camera.zoom * factor));
    const after = this.toWorld(px, py);
    this.camera.x += before.x - after.x;
    this.camera.z += before.z - after.z;
    this.clamp();
  }

  centerOn(x: number, z: number): void {
    this.camera.x = x;
    this.camera.z = z;
    this.clamp();
  }

  private clamp(): void {
    const half = MAP_SIZE / 2;
    this.camera.x = Math.min(half, Math.max(-half, this.camera.x));
    this.camera.z = Math.min(half, Math.max(-half, this.camera.z));
  }

  draw(world: CityWorld, opts: PlanOptions = {}): void {
    const { ctx } = this;
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, this.width, this.height);

    this.drawTerrain(world);
    if (opts.showZones) this.drawZoneCells(world);
    this.drawNetwork(world);
    this.drawBuildings(world);
    if (opts.civic) this.drawCivic(opts.civic, opts.showReach ?? false);
    this.drawStations(world);
    this.drawVehicles(world);
    if (opts.preview && opts.preview.length > 1) {
      this.strokePolyline(opts.preview, COLORS.preview, Math.max(2, this.camera.zoom * 3));
    }
    if (opts.cursor) this.ring(opts.cursor, COLORS.cursor, 6);
    if (opts.focus) this.ring(opts.focus, COLORS.focus, 14);
  }

  /**
   * The ground: one shaded cell per sample, plus the water.
   *
   * Shading comes from the height *difference* to the next sample rather than
   * from the height itself, which is what makes a slope read as a slope on a
   * map where the whole town sits at twenty metres.
   */
  private drawTerrain(world: CityWorld): void {
    const { ctx } = this;
    const step = TERRAIN_STEP;
    const min = this.toWorld(0, 0);
    const max = this.toWorld(this.width, this.height);
    const x0 = Math.floor(min.x / step) * step;
    const z0 = Math.floor(min.z / step) * step;
    const size = step * this.camera.zoom + 1;

    for (let z = z0; z <= max.z; z += step) {
      for (let x = x0; x <= max.x; x += step) {
        const h = world.field.baseHeightAt(x, z);
        const p = this.toScreen(x, z);
        if (h < WATER_LEVEL) {
          ctx.fillStyle = COLORS.water;
        } else {
          const slope = h - world.field.baseHeightAt(x + step, z + step);
          const shade = Math.max(-1, Math.min(1, slope / 6));
          const base = 74 + Math.min(46, Math.max(0, h) * 0.5);
          const r = Math.round(base * 0.62 + shade * 18);
          const g = Math.round(base + shade * 26);
          const b = Math.round(base * 0.58 + shade * 14);
          ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
        }
        ctx.fillRect(p.x, p.y, size, size);
      }
    }
  }

  /** Roads and railways, drawn at their real width along their alignments. */
  private drawNetwork(world: CityWorld): void {
    const { ctx } = this;
    for (const segment of world.net.segments.values()) {
      const cls = world.net.classOf(segment);
      const alignment = world.net.alignmentOf(segment.id);
      const points = samplePolyline(alignment, Math.max(4, 24 / this.camera.zoom));
      if (points.length < 2) continue;

      const width = Math.max(1.5, cls.halfWidth * 2 * this.camera.zoom);
      if (cls.kind === 'road') {
        this.strokePolyline(points, COLORS.roadEdge, width + 2);
        this.strokePolyline(points, COLORS.road, width);
      } else {
        this.strokePolyline(points, COLORS.rail, width + 1.5);
        this.strokePolyline(points, COLORS.railTie, Math.max(1, width * 0.45));
      }
      ctx.lineWidth = 1;
    }
  }

  /** The plots, in the colour of the use painted on them. */
  private drawZoneCells(world: CityWorld): void {
    const { ctx } = this;
    const cells = world.result?.zoneCells ?? [];
    for (const cell of cells) {
      if (!cell.zone) continue;
      const [r, g, b] = ZONE_COLORS[cell.zone];
      ctx.fillStyle = `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${
        Math.round(b * 255)}, ${cell.buildable ? 0.45 : 0.2})`;
      this.fillRotatedRect(cell.center, cell.along, cell.outward, 3.6, 4.6);
    }
  }

  /** Buildings, as the footprint the 3D view puts a building on. */
  private drawBuildings(world: CityWorld): void {
    const { ctx } = this;
    const built = world.builder.builtLots;
    for (const [index, lot] of world.lots.entries()) {
      if (built && !built.has(index)) continue;
      const [r, g, b] = ZONE_COLORS[lot.zone];
      ctx.fillStyle = `rgb(${Math.round(r * 220)}, ${Math.round(g * 220)}, ${Math.round(b * 220)})`;
      this.fillRotatedRect(lot.center, lot.along, lot.outward, lot.halfFrontage, lot.depth / 2);
    }
  }

  /**
   * The city's own buildings, each with the ground it serves washed around it.
   *
   * The catchment is the whole reason to draw these on a map rather than only
   * in the world: "is this neighbourhood covered" is a question you answer by
   * looking down at it, and a hospital is a dot until you can see how far its
   * reach goes.
   */
  private drawCivic(buildings: readonly CityBuilding[], showReach: boolean): void {
    const { ctx } = this;
    for (const building of buildings) {
      const kind = civicKind(building.type);
      if (!kind) continue;
      const p = this.toScreen(building.at.x, building.at.z);
      const color = civicColor(building.type);

      // The catchment is an outline by default and a wash only while
      // something is being placed. Half a dozen washes stacked on top of each
      // other hide the town they are drawn over, which defeats the purpose:
      // the question is where the *gaps* are, and you cannot see a gap
      // through six layers of paint.
      ctx.beginPath();
      ctx.arc(p.x, p.y, kind.reach * this.camera.zoom, 0, Math.PI * 2);
      if (showReach) {
        ctx.globalAlpha = 0.09;
        ctx.fillStyle = color;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 5]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      const size = Math.max(4, kind.half * 2 * this.camera.zoom);
      ctx.fillStyle = color;
      ctx.fillRect(p.x - size / 2, p.y - size / 2, size, size);
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(p.x - size / 2, p.y - size / 2, size, size);
    }
  }

  private drawStations(world: CityWorld): void {
    const { ctx } = this;
    ctx.strokeStyle = COLORS.station;
    ctx.lineWidth = 2;
    for (const station of world.net.stations.values()) {
      const along = new Vector3(Math.cos(station.heading), 0, Math.sin(station.heading));
      const across = new Vector3(-along.z, 0, along.x);
      const a = this.toScreen(
        station.center.x - along.x * station.length / 2 - across.x * 12,
        station.center.z - along.z * station.length / 2 - across.z * 12,
      );
      const b = this.toScreen(
        station.center.x + along.x * station.length / 2 + across.x * 12,
        station.center.z + along.z * station.length / 2 + across.z * 12,
      );
      ctx.strokeRect(
        Math.min(a.x, b.x),
        Math.min(a.y, b.y),
        Math.abs(b.x - a.x),
        Math.abs(b.y - a.y),
      );
    }
  }

  private drawVehicles(world: CityWorld): void {
    const { ctx } = this;
    for (const vehicle of world.traffic.vehicles) {
      const pose = vehicle.bodies[0];
      if (!pose) continue;
      const p = this.toScreen(pose.pos.x, pose.pos.z);
      const size = Math.max(2, (vehicle.kind === 'train' ? 3.2 : 2.2) * this.camera.zoom);
      ctx.fillStyle = vehicle.kind === 'train' ? COLORS.train : COLORS.vehicle;
      ctx.fillRect(p.x - size / 2, p.y - size / 2, size, size);
    }
  }

  private fillRotatedRect(
    center: Vector3,
    along: Vector3,
    outward: Vector3,
    halfAlong: number,
    halfOut: number,
  ): void {
    const { ctx } = this;
    const corner = (a: number, o: number): { x: number; y: number } =>
      this.toScreen(
        center.x + along.x * a + outward.x * o,
        center.z + along.z * a + outward.z * o,
      );
    const p0 = corner(-halfAlong, -halfOut);
    const p1 = corner(halfAlong, -halfOut);
    const p2 = corner(halfAlong, halfOut);
    const p3 = corner(-halfAlong, halfOut);
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.lineTo(p3.x, p3.y);
    ctx.closePath();
    ctx.fill();
  }

  private strokePolyline(points: readonly Vector3[], color: string, width: number): void {
    const { ctx } = this;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    points.forEach((point, i) => {
      const p = this.toScreen(point.x, point.z);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();
  }

  private ring(at: Vector3, color: string, radius: number): void {
    const { ctx } = this;
    const p = this.toScreen(at.x, at.z);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(radius, radius * this.camera.zoom), 0, Math.PI * 2);
    ctx.stroke();
  }
}

/** An alignment as a polyline, sampled finely enough for the current zoom. */
export function samplePolyline(
  alignment: { length: number; sampleAt(s: number): { pos: Vector3 } },
  spacing: number,
): Vector3[] {
  const steps = Math.max(1, Math.ceil(alignment.length / spacing));
  const out: Vector3[] = [];
  for (let i = 0; i <= steps; i++) {
    out.push(alignment.sampleAt((alignment.length * i) / steps).pos.clone());
  }
  return out;
}

/** True when a segment is a railway, for anything drawing them differently. */
export function isRail(world: CityWorld, segment: NetSegment): boolean {
  return world.net.classOf(segment).kind === 'rail';
}
