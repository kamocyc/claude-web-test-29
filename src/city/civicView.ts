import { Group, Mesh, Vector3, type BufferGeometry, type Material } from 'three';
import { MeshBuilder } from '../track/core/meshbuilder';
import { addBox } from '../track/build/primitives';
import { createPropMaterial } from '../track/render/materials';
import type { RGB } from '../track/build/surface';
import { BuildingType } from '../core/types';
import type { Heightfield } from '../track/terrain/heightfield';
import type { CityBuilding } from './buildings';
import { civicKind } from './civic';

/**
 * The city's own buildings, in three dimensions.
 *
 * Massing, not architecture: a shape, a colour and a roof that say at a
 * glance which of the seven this is and how much ground it takes. That is
 * enough, because the question these buildings exist to answer is a question
 * about the map -- is this neighbourhood covered -- and a detailed model of a
 * hospital would answer it no better than a white block with a red roof.
 *
 * They are drawn here rather than by the engine because the engine draws
 * buildings on *plots*, and these do not stand on plots. Keeping them apart
 * also means re-laying a street rebuilds the whole town's houses without
 * touching a single civic building, which is what should happen.
 */

interface Massing {
  /** Half the footprint [m]. */
  half: { x: number; z: number };
  /** How tall the main block is [m]. */
  height: number;
  wall: RGB;
  roof: RGB;
  /** A lower apron around it: a car park, a forecourt, a lawn. */
  apron?: { half: number; color: RGB };
  /** Something on top, so the silhouette is not seven identical boxes. */
  cap?: 'tower' | 'mast' | 'dome' | 'wheel';
}

const MASSING: Partial<Record<BuildingType, Massing>> = {
  [BuildingType.Park]: {
    half: { x: 15, z: 15 }, height: 0.6,
    wall: [0.33, 0.62, 0.33], roof: [0.36, 0.68, 0.36],
    apron: { half: 16, color: [0.3, 0.56, 0.31] },
  },
  [BuildingType.School]: {
    half: { x: 20, z: 11 }, height: 9,
    wall: [0.9, 0.86, 0.74], roof: [0.55, 0.42, 0.36],
    apron: { half: 22, color: [0.55, 0.56, 0.5] },
    cap: 'mast',
  },
  [BuildingType.Hospital]: {
    half: { x: 17, z: 14 }, height: 20,
    wall: [0.94, 0.94, 0.95], roof: [0.72, 0.24, 0.24],
    apron: { half: 24, color: [0.5, 0.51, 0.53] },
    cap: 'tower',
  },
  [BuildingType.PoliceStation]: {
    half: { x: 13, z: 10 }, height: 9,
    wall: [0.42, 0.5, 0.66], roof: [0.22, 0.28, 0.42],
    apron: { half: 17, color: [0.45, 0.46, 0.5] },
    cap: 'mast',
  },
  [BuildingType.FireStation]: {
    half: { x: 14, z: 10 }, height: 9,
    wall: [0.74, 0.28, 0.24], roof: [0.4, 0.16, 0.14],
    apron: { half: 17, color: [0.45, 0.46, 0.5] },
    cap: 'mast',
  },
  [BuildingType.Stadium]: {
    half: { x: 30, z: 24 }, height: 16,
    wall: [0.8, 0.8, 0.82], roof: [0.5, 0.52, 0.56],
    apron: { half: 33, color: [0.42, 0.55, 0.38] },
    cap: 'dome',
  },
  [BuildingType.AmusementPark]: {
    half: { x: 34, z: 30 }, height: 7,
    wall: [0.92, 0.72, 0.34], roof: [0.8, 0.35, 0.42],
    apron: { half: 38, color: [0.5, 0.6, 0.4] },
    cap: 'wheel',
  },
};

const RIGHT = new Vector3(1, 0, 0);
const UP = new Vector3(0, 1, 0);
const FORWARD = new Vector3(0, 0, 1);

export class CivicView {
  readonly group = new Group();
  private readonly material: Material;
  private readonly mesh: Mesh;
  /** What was drawn last, so an unchanged city is not rebuilt every frame. */
  private signature = '';

  constructor() {
    this.material = createPropMaterial();
    this.mesh = new Mesh(new MeshBuilder().build(), this.material);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.group.add(this.mesh);
  }

  /** Redraw, but only when the set of buildings has actually changed. */
  update(buildings: readonly CityBuilding[], field: Heightfield): void {
    const civic = buildings.filter((b) => b.alive && MASSING[b.type]);
    const signature = civic.map((b) => `${b.id}:${b.type}`).join(',');
    if (signature === this.signature) return;
    this.signature = signature;

    const mb = new MeshBuilder();
    for (const building of civic) this.add(mb, building, field);
    this.replace(mb.build());
  }

  private add(mb: MeshBuilder, building: CityBuilding, field: Heightfield): void {
    const shape = MASSING[building.type];
    if (!shape) return;
    const ground = field.heightAt(building.at.x, building.at.z);
    const at = (y: number): Vector3 => new Vector3(building.at.x, ground + y, building.at.z);

    if (shape.apron) {
      addBox(mb, at(0.15), RIGHT, UP, FORWARD,
        { x: shape.apron.half, y: 0.15, z: shape.apron.half * 0.8 }, shape.apron.color);
    }
    const h = shape.height;
    addBox(mb, at(h / 2), RIGHT, UP, FORWARD,
      { x: shape.half.x, y: h / 2, z: shape.half.z }, shape.wall);
    // A roof slab a little wider than the walls: the overhang is what makes a
    // box read as a building rather than as a crate.
    addBox(mb, at(h + 0.5), RIGHT, UP, FORWARD,
      { x: shape.half.x + 0.8, y: 0.5, z: shape.half.z + 0.8 }, shape.roof);

    switch (shape.cap) {
      case 'tower':
        addBox(mb, at(h + 6), RIGHT, UP, FORWARD, { x: 4, y: 5, z: 4 }, shape.wall);
        addBox(mb, at(h + 11.5), RIGHT, UP, FORWARD, { x: 4.6, y: 0.5, z: 4.6 }, shape.roof);
        break;
      case 'mast':
        addBox(mb, at(h + 4), RIGHT, UP, FORWARD, { x: 0.5, y: 4, z: 0.5 }, shape.roof);
        break;
      case 'dome':
        // Three shrinking slabs: a stand roof read from a distance.
        for (let i = 1; i <= 3; i++) {
          addBox(mb, at(h + 1 + i * 1.6), RIGHT, UP, FORWARD, {
            x: shape.half.x * (1 - i * 0.22),
            y: 0.8,
            z: shape.half.z * (1 - i * 0.22),
          }, shape.roof);
        }
        break;
      case 'wheel': {
        // A big wheel: a ring of blocks on edge. The one silhouette in the
        // city that says "come here on your day off" from across town.
        const radius = 14;
        const hub = at(h + radius + 2);
        for (let i = 0; i < 12; i++) {
          const angle = (Math.PI * 2 * i) / 12;
          const car = hub.clone();
          car.x += Math.cos(angle) * radius;
          car.y += Math.sin(angle) * radius;
          addBox(mb, car, RIGHT, UP, FORWARD, { x: 1.2, y: 1.2, z: 1.2 },
            i % 2 === 0 ? shape.roof : shape.wall);
        }
        addBox(mb, at((h + radius + 2) / 2), RIGHT, UP, FORWARD,
          { x: 1, y: (h + radius + 2) / 2, z: 1 }, shape.roof);
        break;
      }
      default:
        break;
    }
  }

  private replace(geometry: BufferGeometry): void {
    this.mesh.geometry.dispose();
    this.mesh.geometry = geometry;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

/** The colour a civic building is drawn in on the plan. */
export function civicColor(type: BuildingType): string {
  const shape = MASSING[type];
  const rgb = shape?.wall ?? [0.8, 0.8, 0.8];
  return `rgb(${Math.round(rgb[0] * 255)}, ${Math.round(rgb[1] * 255)}, ${Math.round(rgb[2] * 255)})`;
}

/** Half the footprint drawn on the plan [m]. */
export function civicFootprint(type: BuildingType): number {
  return civicKind(type)?.half ?? 12;
}
