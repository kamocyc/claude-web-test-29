import { MeshBasicMaterial } from 'three';
import { Network } from '../track/network/network';
import { LineMap } from '../track/network/line';
import type { Lot } from '../track/network/zoning';
import { WorldBuilder, type BuildResult } from '../track/render/worldBuilder';
import { DEFAULT_TERRAIN, generateTerrain } from '../track/terrain/generator';
import { Heightfield } from '../track/terrain/heightfield';
import { TerrainMesh } from '../track/terrain/terrainMesh';
import { createTerrainMaterial } from '../track/render/materials';
import { CityTerrain } from './terrain';

/**
 * The city's world: the ground, the network laid on it, and everything the
 * engine derives from the two.
 *
 * This is the replacement for the tile map. The city used to be a stack of
 * `Uint8Array` layers where a road was a tile with a flag on it; it is now an
 * ordered set of **alignments** -- horizontal curves with easements, vertical
 * profiles with curves and cant -- and every question the game used to ask of
 * a tile ("is this a road?", "what is next to it?", "can a lorry get there?")
 * is asked of the derived world instead.
 *
 * The derivation is the ported `WorldBuilder`. It is the expensive part and it
 * runs only when something is actually laid or painted: junctions are solved,
 * structures decided, the terrain graded, lots laid out along the roads, the
 * lane graph rebuilt and the line plans re-routed. Everything downstream --
 * the 3D scene, the plan view, the simulation -- reads its result rather than
 * working any of it out again, which is what keeps the map, the panels and the
 * simulation unable to disagree.
 */
export class CityWorld {
  readonly field = new Heightfield();
  readonly terrain = new CityTerrain(this.field);
  readonly net = new Network();
  readonly terrainMesh: TerrainMesh;
  readonly builder: WorldBuilder;

  /** Bumped whenever the world is rebuilt, so views can refresh. */
  revision = 0;

  /** The last derivation. Null until the first rebuild. */
  result: BuildResult | null = null;

  private dirty = true;

  /**
   * @param seed  Terrain and resources come from one seed, so a city is
   *              reproducible from a single number -- which is what lets a
   *              save carry the ground without carrying a heightfield.
   * @param headless  Skip the shader material. Tests build worlds by the
   *              hundred and never render them; the real material compiles
   *              GLSL that Node has no use for.
   */
  constructor(readonly seed = DEFAULT_TERRAIN.seed, headless = false) {
    generateTerrain(this.field, { ...DEFAULT_TERRAIN, seed });
    this.terrain.generate(seed);
    this.terrainMesh = new TerrainMesh(
      this.field,
      headless ? new MeshBasicMaterial() : createTerrainMaterial(),
    );
    this.builder = new WorldBuilder(this.net, this.field, this.terrainMesh);
  }

  /** What the player painted, kept across re-laying. */
  get zones() {
    return this.builder.zones;
  }

  /** The lines the player opened, kept across re-laying. */
  get lines(): LineMap {
    return this.builder.lines;
  }

  get lots(): Lot[] {
    return this.builder.lots;
  }

  get laneGraph() {
    return this.builder.laneGraph;
  }

  get traffic() {
    return this.builder.traffic;
  }

  /** Something was laid, painted or removed: the derivation is stale. */
  markDirty(): void {
    this.dirty = true;
  }

  /**
   * Re-derive the world if anything changed. Returns true when it actually
   * ran, so callers can do their own work (re-attaching buildings, refreshing
   * a view) only when there is something to do.
   */
  rebuildIfNeeded(): boolean {
    if (!this.dirty) return false;
    this.dirty = false;
    this.result = this.builder.rebuild();
    this.revision++;
    return true;
  }

  /** Force a rebuild, whether or not anything is known to have changed. */
  rebuild(): BuildResult {
    this.dirty = false;
    this.result = this.builder.rebuild();
    this.revision++;
    return this.result;
  }
}
