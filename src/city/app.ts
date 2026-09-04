import { Vector3 } from 'three';
import { BuildTool, type ToolMode } from '../track/app/buildTool';
import { Viewport } from '../track/app/viewport';
import { SnapView } from '../track/render/snapView';
import { NETWORK_CLASSES } from '../track/network/classes';
import { ZONE_LABELS, ZONE_TYPES, type ZoneType } from '../track/network/zoning';
import { applyCity, captureCity, writeSave, type CitySave } from './persistence';
import { PlanView } from './plan';
import { seedStartingTown } from './scenario';
import { CitySimulation } from './simulation';
import { CityWorld } from './world';

/**
 * The city, as an application: one world, two ways of looking at it, and one
 * set of tools that work in both.
 *
 * The view toggle is not a cosmetic choice. Laying a *network* is a plan-view
 * job -- whether two streets meet is a question about lines on a map -- while
 * everything the alignment model exists for (a road on an embankment, a
 * railway under a bridge, the cut through a hill) can only be judged from
 * inside the world. So the tool state lives here, above both views, and each
 * view only has to answer one question: where on the ground is the cursor?
 */

export type ViewMode = '3d' | 'plan';

export interface CityAppOptions {
  /** The 3D canvas. */
  canvas3d: HTMLCanvasElement;
  /** The plan-view canvas. */
  canvas2d: HTMLCanvasElement;
  seed?: number;
  /**
   * A city to open instead of a new one.
   *
   * Its seed decides the ground, so it is handed in at construction rather
   * than poured into a world that has already generated different terrain.
   */
  save?: CitySave;
}

export class CityApp {
  readonly world: CityWorld;
  readonly sim: CitySimulation;
  readonly viewport: Viewport;
  readonly plan: PlanView;
  readonly tool: BuildTool;
  /** Where the opening town was laid. */
  readonly centre: Vector3;

  view: ViewMode = '3d';

  /** Where the cursor is on the ground, in whichever view is active. */
  cursor: Vector3 | null = null;
  readonly modifiers = { straight: false, noSnap: false };

  /** A place to ring because a warning or a panel asked to be shown. */
  private focus: Vector3 | null = null;
  private focusUntil = 0;
  private readonly focusView = new SnapView('city-focus');

  private readonly ctx2d: CanvasRenderingContext2D;
  private lastFrame = performance.now();
  /** Seconds of world time, for the engine's signals and vehicles. */
  private clock = 0;

  constructor(private readonly options: CityAppOptions) {
    this.world = new CityWorld(options.seed);
    this.sim = new CitySimulation(this.world);
    this.viewport = new Viewport(options.canvas3d);
    this.ctx2d = options.canvas2d.getContext('2d')!;
    this.plan = new PlanView(this.ctx2d);

    this.viewport.scene.add(this.world.terrainMesh.group);
    this.viewport.scene.add(this.world.builder.group);
    this.viewport.scene.add(this.focusView.group);

    this.tool = new BuildTool(
      this.world.net,
      this.world.field,
      () => this.world.markDirty(),
      this.world.builder,
      this.world.zones,
      this.world.lines,
    );
    this.viewport.scene.add(this.tool.previewGroup);

    if (options.save) {
      applyCity(this.world, this.sim, options.save);
      this.centre = centreOf(this.world);
    } else {
      // The town picks its own site on the generated ground, so the camera has
      // to be told where it ended up rather than assuming the origin.
      this.centre = seedStartingTown(this.world);
      this.world.rebuild();
    }
    this.plan.centerOn(this.centre.x, this.centre.z);
    this.lookAt(this.centre.x, this.centre.z, 520);
  }

  // ----------------------------------------------------------------- saving

  /** Write the city to the browser. Returns what was written. */
  save(): CitySave {
    const save = captureCity(this.world, this.sim);
    writeSave(save);
    return save;
  }

  /**
   * Open a saved city in place.
   *
   * Only possible when the save came from this world's own seed: the ground is
   * generated once, at construction, so a save of different terrain has to be
   * opened by starting again rather than by swapping the hills underneath a
   * running city. The caller is told which happened.
   */
  load(save: CitySave): boolean {
    if (save.seed !== this.world.seed) return false;
    applyCity(this.world, this.sim, save);
    this.tool.cancel();
    this.world.traffic.reset(this.world.laneGraph);
    this.world.traffic.setLines(this.world.builder.linePlans);
    this.showPlace(centreOf(this.world));
    return true;
  }

  // ------------------------------------------------------------------ views

  setView(view: ViewMode): void {
    if (this.view === view) return;
    // Carry the eye across: the plan is centred on what the 3D camera was
    // looking at, and the 3D camera drops onto what the plan was showing.
    if (view === 'plan') {
      const target = this.viewport.controls.target;
      this.plan.centerOn(target.x, target.z);
    } else {
      this.lookAt(this.plan.camera.x, this.plan.camera.z, Math.max(160, 400 / this.plan.camera.zoom));
    }
    this.view = view;
    this.options.canvas3d.style.display = view === '3d' ? 'block' : 'none';
    this.options.canvas2d.style.display = view === 'plan' ? 'block' : 'none';
  }

  /** Point the 3D camera at a place on the ground. */
  lookAt(x: number, z: number, distance = 320, azimuth = Math.PI * 0.25): void {
    const y = this.world.field.heightAt(x, z);
    this.viewport.controls.target.set(x, y, z);
    this.viewport.camera.position.set(
      x + Math.cos(azimuth) * distance,
      y + distance * 0.6,
      z + Math.sin(azimuth) * distance,
    );
    this.viewport.controls.update();
  }

  /** Take whichever view is active to a place, and ring it. */
  showPlace(at: Vector3, seconds = 6): void {
    if (this.view === '3d') this.viewport.panTo(at);
    else this.plan.centerOn(at.x, at.z);
    this.focus = at.clone();
    this.focusUntil = performance.now() + seconds * 1000;
  }

  // ------------------------------------------------------------------ input

  /**
   * Where the pointer is on the ground.
   *
   * In 3D the ray is cast at the terrain *and the road surfaces*, so pointing
   * at a bridge gives the bridge deck rather than the valley under it. In the
   * plan there is no ray: the ground is wherever the pointer is, at the height
   * the terrain has there.
   */
  pick(clientX: number, clientY: number, rect: DOMRect): Vector3 | null {
    if (this.view === '3d') {
      this.viewport.setPointer(clientX, clientY);
      return this.viewport.pick([
        ...this.world.terrainMesh.meshes,
        this.world.builder.surfaceMesh,
      ]);
    }
    const at = this.plan.toWorld(clientX - rect.left, clientY - rect.top);
    if (!this.world.field.contains(at.x, at.z)) return null;
    return new Vector3(at.x, this.world.field.heightAt(at.x, at.z), at.z);
  }

  setMode(mode: ToolMode): void {
    this.tool.setMode(mode);
    this.world.builder.setZoneView(mode === 'zone');
    this.world.builder.setLineView(mode === 'line');
  }

  setZone(zone: ZoneType | null): void {
    this.tool.setZone(zone);
  }

  setClass(classId: string): void {
    this.tool.setClass(classId);
  }

  // ------------------------------------------------------------------ frame

  /** One frame: advance the world, update the tool, draw the active view. */
  frame(now = performance.now()): void {
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    if (this.world.rebuildIfNeeded()) {
      // The lane graph and the line plans were rebuilt under the traffic.
      this.world.traffic.reset(this.world.laneGraph);
      this.world.traffic.setLines(this.world.builder.linePlans);
    }

    this.tool.update(this.cursor, this.modifiers);
    // The city drives the traffic (its citizens are the cars), so the engine
    // animates *without* stepping the traffic again -- it only moves the
    // signals, the gates and the meshes to where the simulation has put
    // things. Both read the same clock, so a car never sits at a light the
    // renderer is drawing green.
    this.sim.step(dt);
    this.clock = this.world.traffic.time;
    this.world.builder.animate(this.clock, 0);

    if (now > this.focusUntil) this.focus = null;
    this.focusView.update(
      this.focus
        ? [{
          kind: 'focus',
          pos: this.focus.clone(),
          radius: Math.max(8, this.viewport.viewDistance * 0.06),
          width: 2,
        }]
        : [],
    );

    if (this.view === '3d') {
      this.viewport.render();
    } else {
      this.plan.draw(this.world, {
        preview: this.tool.previewPolyline(Math.max(2, 12 / this.plan.camera.zoom)),
        focus: this.focus,
        cursor: this.cursor,
        showZones: this.tool.mode === 'zone',
      });
    }
  }

  resize(): void {
    this.viewport.resize();
    const canvas = this.options.canvas2d;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    this.ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.plan.resize(width, height);
  }
}

/** The road and rail classes the toolbar offers, in the order it shows them. */
export const BUILD_CLASSES = NETWORK_CLASSES.map((cls) => ({
  id: cls.id,
  label: cls.label,
  kind: cls.kind,
}));

/** The uses the zone tool offers. */
export const ZONE_CHOICES = ZONE_TYPES.map((zone) => ({ zone, label: ZONE_LABELS[zone] }));

/** The middle of whatever has been built, for pointing the camera at it. */
function centreOf(world: CityWorld): Vector3 {
  const centre = new Vector3();
  let count = 0;
  for (const node of world.net.nodes.values()) {
    centre.add(node.pos);
    count++;
  }
  return count === 0 ? centre : centre.multiplyScalar(1 / count);
}
