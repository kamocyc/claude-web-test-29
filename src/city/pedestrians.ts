import { Color, Group, Matrix4, Quaternion, Vector3 } from 'three';
import { agentSurface, type AgentSurface } from '../look/agentMaterial';
import { InstancePool } from '../look/instancePool';
import {
  bodyGeometry,
  limbGeometry,
  LIMB_PIVOT_Y,
  PED_HEIGHT,
  pedColor,
  simpleGeometry,
} from '../look/pedestrianParts';
import type { Atmosphere } from '../look/sky';
import { CitizenState, type CityCitizen } from './citizens';
import type { CityWorld } from './world';

/**
 * The people, drawn.
 *
 * The city has always simulated them one at a time -- each has a home, a job,
 * an hour they leave and a route they take -- and drawn none of them. A city
 * whose streets are empty of people while its panels report a population of
 * four hundred is telling the player two different stories.
 *
 * A walker is a body and two limb groups, in three instanced meshes: the arms
 * and legs have to swing, and one instance carries one matrix, so the parts
 * that move differently have to be separate instances. They are split as
 * "left leg with right arm" and "right leg with left arm", because that is
 * how a person actually walks -- opposite limbs swing together -- so two
 * rigid groups is enough, and it costs two draw calls instead of four.
 *
 * Only the ones near the camera are drawn in full; further out they drop to a
 * simpler shape, and beyond that they are not drawn at all. A person is a few
 * dozen pixels tall from the height a city is usually watched from.
 */

/** Nobody is drawn beyond this [m]. */
const REACH = 340;
/** Inside this they get arms and legs [m]. */
const DETAIL = 150;
/** How far a stride carries [m]; the swing is timed off distance walked. */
const STRIDE = 0.72;

const UP = new Vector3(0, 1, 0);
/** The person's own left-right axis, which the limbs swing about. */
const RIGHT = new Vector3(1, 0, 0);
const ONE = new Vector3(1, 1, 1);
/** How far in from the outer edge of the paving the footway's middle is. */
const FOOTWAY_INSET = 0.5;

export class Pedestrians {
  readonly group = new Group();
  private readonly body: InstancePool;
  private readonly limbA: InstancePool;
  private readonly limbB: InstancePool;
  private readonly simple: InstancePool;
  private readonly skin: AgentSurface;

  // Scratch, reused for every person: this runs over the whole population
  // every frame, and allocating a handful of vectors each time would be the
  // most expensive thing in it.
  private readonly matrix = new Matrix4();
  private readonly yawQ = new Quaternion();
  private readonly swingQ = new Quaternion();
  private readonly limbQ = new Quaternion();
  private readonly limbPos = new Vector3();
  private readonly footV = new Vector3();
  private readonly tint = new Color();

  constructor() {
    this.group.name = 'pedestrians';
    this.skin = agentSurface({ roughness: 0.82, metalness: 0.02, skin: true, nightLift: 0.6 });
    const material = this.skin.material;
    this.body = new InstancePool(bodyGeometry(), material, this.group, true, 512);
    this.limbA = new InstancePool(limbGeometry(1), material, this.group, true, 512);
    this.limbB = new InstancePool(limbGeometry(-1), material, this.group, true, 512);
    this.simple = new InstancePool(simpleGeometry(), material, this.group, true, 1024);
    for (const pool of [this.body, this.limbA, this.limbB, this.simple]) {
      pool.setShadows(true, false);
    }
  }

  /** Keep them readable after dark, as the source does for vehicles. */
  setAtmosphere(atmo: Atmosphere): void {
    this.skin.night.value = atmo.nightAmount;
    this.skin.glassSky.value.copy(atmo.zenith);
    this.skin.glassHorizon.value.copy(atmo.horizon);
    this.skin.glassGround.value.copy(atmo.horizon).multiplyScalar(0.4);
  }

  /**
   * Put a person wherever a citizen is on foot.
   *
   * Rebuilt every frame: they are walking, so last frame's positions are
   * wrong by definition. Everything here is per-person arithmetic and three
   * instanced meshes, which is what makes that affordable.
   */
  update(world: CityWorld, citizens: readonly CityCitizen[], eye: Vector3): void {
    for (const pool of [this.body, this.limbA, this.limbB, this.simple]) pool.begin();

    for (const citizen of citizens) {
      // Somebody in a vehicle is in the vehicle; somebody at home or at work
      // is indoors. What is left is the people actually on the pavement.
      if (citizen.vehicle >= 0 || citizen.left) continue;
      if (citizen.state !== CitizenState.ToWork && citizen.state !== CitizenState.ToHome) continue;

      const distance = Math.hypot(citizen.at.x - eye.x, citizen.at.z - eye.z);
      if (distance > REACH) continue;

      const walking = walkPose(world, citizen);
      // Off the carriageway. The route is over the lane graph, because that
      // is the only graph there is, but a person walking down the middle of
      // the road is the first thing anybody would notice.
      const x = citizen.at.x + (walking ? -walking.dir.z * walking.offset : 0);
      const z = citizen.at.z + (walking ? walking.dir.x * walking.offset : 0);
      const ground = world.field.heightAt(x, z);
      this.footV.set(x, ground, z);
      pedColor(citizen.seed, this.tint);

      // Facing: along the walk if there is one, otherwise a fixed direction
      // from their seed, so somebody standing still does not spin.
      const heading = walking
        ? Math.atan2(walking.dir.x, walking.dir.z)
        : (citizen.seed % 360) * (Math.PI / 180);
      this.yawQ.setFromAxisAngle(UP, heading);

      if (distance > DETAIL || !citizen.walk) {
        this.matrix.compose(this.footV, this.yawQ, ONE);
        this.simple.push(this.matrix, this.tint);
        continue;
      }

      this.matrix.compose(this.footV, this.yawQ, ONE);
      this.body.push(this.matrix, this.tint);

      // The swing is timed off distance walked, not off the clock, so people
      // held up in a queue stand still instead of marching on the spot.
      const phase = (citizen.walk.travelled / STRIDE) * Math.PI;
      this.pushLimbs(phase, this.tint, this.yawQ, this.footV);
    }

    for (const pool of [this.body, this.limbA, this.limbB, this.simple]) pool.end();
  }

  /**
   * The two limb groups, each swung about the hip/shoulder line.
   *
   * The transform is the person's yaw, then a swing about their *own* left-
   * right axis, about a pivot part-way up the body -- in that order. Getting
   * the order the other way round swings the limbs about a world axis
   * instead, and they come off the body and trail beside it, which is exactly
   * what the first attempt did.
   *
   * The pivot is halfway between hip and shoulder rather than at either. The
   * real joints are in different places, but the error is under ten
   * centimetres on a person a few dozen pixels tall -- cheaper than splitting
   * the mesh into four to be exactly right.
   */
  private pushLimbs(phase: number, tint: Color, yaw: Quaternion, foot: Vector3): void {
    const swing = Math.sin(phase) * 0.55;
    // The limb geometry is authored with its **origin at the pivot** -- every
    // box in it is offset by -LIMB_PIVOT_Y -- so the instance goes at the
    // pivot and nothing else has to be undone. Treating the origin as the
    // foot instead (which the first version did) sinks the legs a metre into
    // the road and slides the hip sideways as they swing.
    this.limbPos.set(foot.x, foot.y + LIMB_PIVOT_Y, foot.z);
    for (const [pool, sign] of [[this.limbA, 1], [this.limbB, -1]] as const) {
      this.swingQ.setFromAxisAngle(RIGHT, swing * sign);
      this.limbQ.copy(yaw).multiply(this.swingQ);
      this.matrix.compose(this.limbPos, this.limbQ, ONE);
      pool.push(this.matrix, tint);
    }
  }
}

/**
 * Where along their route a walker is: which way they face, and how far to
 * step aside for the kerb.
 *
 * The offset comes from the road's own half-width, so a pavement beside a
 * six-lane road is where a six-lane road's pavement is.
 */
function walkPose(
  world: CityWorld,
  citizen: CityCitizen,
): { dir: Vector3; offset: number } | null {
  const walk = citizen.walk;
  if (!walk) return null;
  let left = walk.travelled;
  for (const id of walk.route.lanes) {
    const lane = world.laneGraph.lanes[id];
    if (!lane) break;
    if (left <= lane.path.length) {
      const pose = lane.path.poseAt(Math.max(0, left));
      const segment = lane.segment !== undefined ? world.net.segments.get(lane.segment) : undefined;
      const cls = segment ? world.net.classOf(segment) : null;
      // The middle of the footway, which is inside the paving's outer edge --
      // `halfWidth` already counts the pavement, so adding to it walks people
      // along the grass verge instead.
      const offset = cls
        ? cls.halfWidth - Math.max(0.6, cls.sidewalkWidth / 2) - FOOTWAY_INSET
        : 4;
      return { dir: pose.dir, offset };
    }
    left -= lane.path.length;
  }
  return null;
}

/** Exported so a test can say how tall a person is meant to be. */
export { PED_HEIGHT };
