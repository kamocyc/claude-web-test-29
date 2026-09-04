import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  Color,
  Group,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
} from 'three';
import { InstancePool } from '../look/instancePool';
import type { CityWorld } from './world';

/**
 * The street lighting.
 *
 * Night was the half of the day the port had not reached. The windows come on
 * -- the shape library does that on its own -- but the streets between them
 * stayed black, and a city whose roads go dark at dusk reads as a city with
 * the power cut rather than as a city at night.
 *
 * Two pieces, and only two, because that is all a lamp is from any distance a
 * player actually watches a city from: a warm point where the lamp is, and a
 * pool of light where it falls. There is no light source here in the
 * renderer's sense -- a hundred point lights would cost far more than they
 * are worth, and the pool is what the eye reads anyway.
 *
 * Both fade in with the evening, from the same `nightAmount` that decides the
 * sky and the windows, so nothing can come on at the wrong time.
 */

/** How far apart the lamps are along a road [m]. */
const PITCH = 32;
/** How high the lamp head sits [m]. */
const HEIGHT = 7.2;
/** How wide the pool of light on the road is [m]. */
const POOL_RADIUS = 9;
/** Lamps are laid within this distance of the view [m]. */
const REACH = 900;

const LAMP_COLOR = new Color(0xffd9a0);
const POOL_COLOR = new Color(0xffc98a);

export class StreetLights {
  readonly group = new Group();
  private readonly heads: InstancePool;
  private readonly pools: InstancePool;
  private readonly headMaterial: MeshBasicMaterial;
  private readonly poolMaterial: MeshBasicMaterial;
  private signature = '';

  constructor() {
    this.group.name = 'street-lights';
    // Unlit materials on purpose: these *are* the light. Shading them would
    // make the lamps go dark exactly when they are supposed to be brightest.
    this.headMaterial = new MeshBasicMaterial({
      color: LAMP_COLOR,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    this.poolMaterial = new MeshBasicMaterial({
      color: POOL_COLOR,
      transparent: true,
      opacity: 0,
      blending: AdditiveBlending,
      depthWrite: false,
      // The fade to nothing at the rim is carried on the vertices.
      vertexColors: true,
    });

    this.heads = new InstancePool(lampGeometry(), this.headMaterial, this.group, false, 512);
    this.pools = new InstancePool(poolGeometry(), this.poolMaterial, this.group, false, 512);
    this.pools.mesh.renderOrder = 3;
    this.heads.mesh.renderOrder = 4;
  }

  /** Fade the lamps up with the evening. */
  setNight(night: number): void {
    const on = Math.max(0, Math.min(1, (night - 0.12) / 0.5));
    this.headMaterial.opacity = on;
    // Light, not paint. Pushed much past a third and the pools stop reading
    // as brightness on the road and start reading as yellow discs lying on it.
    this.poolMaterial.opacity = on * 0.32;
    this.group.visible = on > 0.01;
  }

  /** Re-lay the lamps when the roads or the view have changed. */
  update(world: CityWorld, centre: Vector3): void {
    const cx = Math.round(centre.x / 300) * 300;
    const cz = Math.round(centre.z / 300) * 300;
    const signature = `${world.revision}:${cx},${cz}`;
    if (signature === this.signature) return;
    this.signature = signature;

    this.heads.begin();
    this.pools.begin();

    const matrix = new Matrix4();
    const quaternion = new Quaternion();
    const scale = new Vector3(1, 1, 1);
    const poolScale = new Vector3(1, 1, 1);
    const at = new Vector3();

    for (const segment of world.net.segments.values()) {
      const cls = world.net.classOf(segment);
      if (cls.kind !== 'road' || cls.sidewalkWidth < 1) continue;
      const alignment = world.net.alignmentOf(segment.id);
      if (alignment.length < 20) continue;

      // Spaced evenly over the segment rather than from one end, so the gap
      // does not bunch up or open out at every joint.
      const count = Math.max(1, Math.round(alignment.length / PITCH));
      const offset = cls.halfWidth - 0.6;
      for (let i = 0; i < count; i++) {
        const s = (alignment.length * (i + 0.5)) / count;
        const sample = alignment.sampleAt(s);
        const px = sample.pos.x + sample.right.x * offset;
        const pz = sample.pos.z + sample.right.z * offset;
        if (Math.abs(px - cx) > REACH || Math.abs(pz - cz) > REACH) continue;

        at.set(px, sample.pos.y + HEIGHT, pz);
        matrix.compose(at, quaternion, scale);
        this.heads.push(matrix);

        // The pool goes on the carriageway, not under the lamp: the light is
        // thrown across the road by the arm, and a disc hugging the kerb
        // reads as a stain rather than as lighting.
        at.set(
          sample.pos.x + sample.right.x * offset * 0.15,
          sample.pos.y + 0.06,
          sample.pos.z + sample.right.z * offset * 0.15,
        );
        // Sized to the road. A fixed disc spills onto the verge of a lane
        // and a half, which is the giveaway that it is a decal rather than
        // light falling on a surface.
        const spread = Math.min(1, (cls.halfWidth * 1.7) / POOL_RADIUS);
        poolScale.set(spread, 1, spread);
        matrix.compose(at, quaternion, poolScale);
        this.pools.push(matrix);
      }
    }

    this.heads.end();
    this.pools.end();
  }
}

/** The lamp itself: a small bright quad-ish blob, seen from any side. */
function lampGeometry(): BufferGeometry {
  const geom = new BufferGeometry();
  const r = 0.3;
  // Two crossed quads. A sphere would be twelve times the triangles for a
  // shape that is a bright dot on screen either way.
  const positions = new Float32Array([
    -r, -r, 0, r, -r, 0, r, r, 0, -r, -r, 0, r, r, 0, -r, r, 0,
    0, -r, -r, 0, -r, r, 0, r, r, 0, -r, -r, 0, r, r, 0, r, -r,
  ]);
  geom.setAttribute('position', new BufferAttribute(positions, 3));
  geom.computeVertexNormals();
  return geom;
}

/** The pool of light on the road: a disc, lying flat. */
function poolGeometry(): BufferGeometry {
  const geom = new CircleGeometry(POOL_RADIUS, 20);
  geom.rotateX(-Math.PI / 2);
  // Bright in the middle, nothing at the rim. Without the fade the pool is a
  // disc of paint with a hard edge, which is worse than no lighting at all.
  const count = geom.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  const pos = geom.getAttribute('position');
  for (let i = 0; i < count; i++) {
    const d = Math.hypot(pos.getX(i), pos.getZ(i)) / POOL_RADIUS;
    const v = Math.max(0, 1 - d) ** 1.6;
    colors[i * 3] = v;
    colors[i * 3 + 1] = v;
    colors[i * 3 + 2] = v;
  }
  geom.setAttribute('color', new BufferAttribute(colors, 3));
  return geom;
}
