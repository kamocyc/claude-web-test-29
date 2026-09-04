import { Group, Vector3 } from 'three';
import { GroundShadows } from '../look/groundShadow';
import type { Vehicle } from '../track/sim/traffic';

/**
 * The dark patch under a car.
 *
 * The shadow map covers a couple of hundred metres in 2048 pixels, so one
 * texel is about ten centimetres, and the bias that keeps surfaces from
 * shadowing themselves pushes the shadow away from whatever cast it. Between
 * them, the first few tens of centimetres under an object are structurally
 * missing -- and that gap is exactly what makes a car look like it is
 * hovering. No amount of shadow-map resolution fixes it.
 *
 * So each vehicle gets one soft disc laid on the road beneath it. They all go
 * into a single instanced mesh, so a thousand of them is still one draw call.
 * The discs fade out with distance, which hides the point where they stop
 * being drawn: without that, the shadows vanish along a visible line across
 * the middle of the city.
 */

/** Beyond this the shadows are gone [m]. */
const REACH = 420;
/** Inside this they are at full strength [m]. */
const FULL = 240;

export class ContactShadows {
  readonly group = new Group();
  private readonly shadows: GroundShadows;

  constructor(capacity = 1024) {
    this.group.name = 'contact-shadows';
    this.shadows = new GroundShadows(capacity);
    this.group.add(this.shadows.mesh);
  }

  /**
   * Lay one under every vehicle in reach.
   *
   * Cheap enough to redo every frame, and it has to be: the vehicles have
   * moved by then.
   */
  update(vehicles: readonly Vehicle[], eye: Vector3, night: number): void {
    this.shadows.reset();
    // At night the sun is not casting anything, so a hard patch under each
    // car reads as a hole rather than as a shadow. Street lighting is diffuse
    // and comes from above, so what is left is faint and wide.
    this.shadows.setOpacity(0.5 - night * 0.28);

    for (const vehicle of vehicles) {
      for (const pose of vehicle.bodies) {
        const distance = Math.hypot(pose.pos.x - eye.x, pose.pos.z - eye.z);
        if (distance > REACH) continue;
        const strength = distance <= FULL ? 1 : 1 - (distance - FULL) / (REACH - FULL);
        this.shadows.add(
          pose.pos.x,
          // Just above the road. On it, and the two surfaces fight over which
          // is in front, which flickers as the camera moves.
          //
          // A body pose sits *on* the road -- it comes straight from the lane
          // path -- so there is no half-height to take off. Taking one off
          // buried every shadow seventy centimetres under the tarmac.
          pose.pos.y + 0.04,
          pose.pos.z,
          Math.atan2(pose.dir.x, pose.dir.z),
          vehicle.size.width * 1.15,
          vehicle.size.length * 1.05,
          strength,
        );
      }
    }
    this.shadows.finish();
  }

  dispose(): void {
    this.shadows.dispose();
  }
}
