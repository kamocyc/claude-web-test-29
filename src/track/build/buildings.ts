import { Vector3 } from 'three';
import type { MeshBuilder } from '../core/meshbuilder';
import {
  ZONE_CELL,
  ZONE_ROW_DEPTH,
  positionHash,
  type Lot,
  type ZoneCell,
  type ZoneType,
} from '../network/zoning';
import { addBox } from './primitives';
import type { RGB } from './surface';

/**
 * 敷地に建つ建物と、区画のマス目の表示。
 *
 * 建物は用途ごとに決まった組み立て方 (壁 → 屋根 → 付属) で作り、寸法と色は
 * 敷地の位置から決めた擬似乱数で振る。同じ敷地からは必ず同じ建物ができるので、
 * 道路を編集して作り直しても、関係ない所の街並みは変わらない。
 */

/** 区画の表示色 (用途ごと)。 */
export const ZONE_COLORS: Record<ZoneType, RGB> = {
  residential: [0.36, 0.72, 0.4],
  apartment: [0.24, 0.55, 0.3],
  commercial: [0.32, 0.6, 0.92],
  office: [0.24, 0.76, 0.76],
  industrial: [0.92, 0.7, 0.3],
  farm: [0.78, 0.7, 0.32],
  forestry: [0.28, 0.6, 0.4],
  fishery: [0.32, 0.72, 0.8],
  mining: [0.64, 0.48, 0.34],
};

/** 用途を塗っていない区画の表示色。 */
export const ZONE_EMPTY_COLOR: RGB = [0.72, 0.78, 0.86];

/** 建てられない区画 (斜面など) の表示色。 */
export const ZONE_BLOCKED_COLOR: RGB = [0.5, 0.3, 0.3];

/** 区画の縁に空ける隙間 [m]。マス目に見えるようにする。 */
const GRID_GAP = 0.45;

/** 区画の表示を地表から浮かせる量 [m]。 */
const GRID_LIFT = 0.35;

/** マス目を地形に沿わせるために刻む間隔 [m]。地形の格子と同じくらいに保つ。 */
const GRID_STEP = 4;

/** 道路側に空ける前庭の奥行き [m] (用途ごと)。 */
const FRONT_YARD: Record<ZoneType, number> = {
  residential: 3.4,
  apartment: 2.6,
  commercial: 1.6,
  office: 2.0,
  industrial: 2.6,
  // 一次産業は建屋を奥に寄せ、道路側を作業場・畑にする。
  farm: 5.0,
  forestry: 4.0,
  fishery: 3.0,
  mining: 4.0,
};

/** 隣地との離れ [m]。間口いっぱいには建てない。 */
const SIDE_GAP = 2.2;

/** 建物の奥に残す空き [m]。 */
const BACK_GAP = 2.0;

/**
 * footprint の上限 (半分の寸法) [m]。
 *
 * 敷地をまとめると広くなるが、住宅がそのまま大きくなると御殿になってしまう。
 * 住宅は上限を決めて、余った所は庭にする。店舗・工場は敷地なりに建てる。
 */
const MAX_HALF: Record<ZoneType, { along: number; depth: number }> = {
  residential: { along: 6.5, depth: 6.0 },
  apartment: { along: 11, depth: 9 },
  commercial: { along: 40, depth: 40 },
  office: { along: 14, depth: 12 },
  industrial: { along: 40, depth: 40 },
  // 一次産業の「建物」は敷地の中の作業棟なので、敷地なりには広げない。
  farm: { along: 7, depth: 6 },
  forestry: { along: 8, depth: 7 },
  fishery: { along: 8, depth: 7 },
  mining: { along: 9, depth: 8 },
};

const ROOF_COLORS: RGB[] = [
  [0.32, 0.3, 0.34],
  [0.4, 0.24, 0.22],
  [0.24, 0.31, 0.4],
  [0.36, 0.36, 0.33],
];

const HOUSE_COLORS: RGB[] = [
  [0.86, 0.84, 0.78],
  [0.8, 0.78, 0.72],
  [0.74, 0.68, 0.6],
  [0.86, 0.8, 0.7],
  [0.7, 0.74, 0.72],
];

const OFFICE_COLORS: RGB[] = [
  [0.68, 0.72, 0.76],
  [0.58, 0.64, 0.7],
  [0.74, 0.72, 0.68],
  [0.6, 0.66, 0.62],
];

const GLASS: RGB = [0.28, 0.42, 0.5];
const CONCRETE: RGB = [0.62, 0.61, 0.58];
const STEEL: RGB = [0.55, 0.57, 0.58];
const FOUNDATION: RGB = [0.46, 0.45, 0.43];

/** 整地後の地形の高さを引く関数。 */
export type GroundQuery = (x: number, z: number) => number;

/**
 * 区画のマス目を地表に描く。
 *
 * 用途が塗ってあれば用途の色、空いていれば薄い色。区画ツールを使っている
 * 間だけ表示する。
 */
export function buildZoneGrid(mb: MeshBuilder, cells: ZoneCell[], ground: GroundQuery): void {
  const up = new Vector3(0, 1, 0);
  const halfAlong = ZONE_CELL / 2 - GRID_GAP;
  const halfOut = ZONE_ROW_DEPTH / 2 - GRID_GAP;
  // 1 枚の平らな四角だと、起伏のある所で真ん中が地面に潜って穴が開く。
  const nx = Math.max(1, Math.ceil((halfAlong * 2) / GRID_STEP));
  const nz = Math.max(1, Math.ceil((halfOut * 2) / GRID_STEP));
  for (const cell of cells) {
    const color = !cell.buildable
      ? ZONE_BLOCKED_COLOR
      : cell.zone
        ? ZONE_COLORS[cell.zone]
        : ZONE_EMPTY_COLOR;
    const base = mb.vertexCount;
    for (let iz = 0; iz <= nz; iz++) {
      for (let ix = 0; ix <= nx; ix++) {
        const p = offsetPoint(
          cell,
          -halfAlong + (ix / nx) * halfAlong * 2,
          -halfOut + (iz / nz) * halfOut * 2,
        );
        p.y = ground(p.x, p.z) + GRID_LIFT;
        mb.vertex(p, up, 0, 0, color);
      }
    }
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const i = base + ix + iz * (nx + 1);
        mb.quad(i, i + 1, i + nx + 2, i + nx + 1);
      }
    }
  }
}

function offsetPoint(cell: ZoneCell, along: number, out: number): Vector3 {
  return cell.center.clone().addScaledVector(cell.along, along).addScaledVector(cell.outward, out);
}

/**
 * 敷地に建物を建てる。
 *
 * 床の高さは敷地が決める (`Lot.padY` = 道路に接する縁のいちばん高い所)。
 * そこから基礎を、footprint の下でいちばん低い所まで下ろす。傾いた土地でも
 * 建物が浮かず、道路との境に段差も出ない。
 */
export function buildBuilding(mb: MeshBuilder, lot: Lot, ground: GroundQuery): void {
  const rand = mulberry32(positionHash(lot.center.x, lot.center.z));
  const zone = lot.zone;

  const cap = MAX_HALF[zone];
  const halfAlong = Math.min(cap.along, Math.max(2, lot.halfFrontage - SIDE_GAP));
  const yard = FRONT_YARD[zone];
  const halfDepth = Math.min(cap.depth, Math.max(4, lot.depth - yard - BACK_GAP) / 2);

  // 前庭のぶん奥に寄せた footprint の中心。
  const center = lot.center
    .clone()
    .addScaledVector(lot.outward, -lot.depth / 2 + yard + halfDepth);

  const padY = lot.padY;
  let lowY = padY;
  // 基礎の底は footprint の下でいちばん低い所。広い敷地では四隅だけでは
  // 足りないので、縁の中点も見る。
  for (const [a, b] of [
    [-1, -1],
    [0, -1],
    [1, -1],
    [-1, 0],
    [1, 0],
    [-1, 1],
    [0, 1],
    [1, 1],
  ] as const) {
    const corner = footprintCorner(center, lot, a * halfAlong, b * halfDepth);
    lowY = Math.min(lowY, ground(corner.x, corner.z));
  }

  // 基礎。床の高さから、いちばん低い所の少し下まで。
  const footing = Math.max(0.35, padY - lowY + 0.4);
  addBox(
    mb,
    new Vector3(center.x, padY - footing / 2, center.z),
    lot.along,
    UP,
    lot.outward,
    { x: halfAlong + 0.25, y: footing / 2, z: halfDepth + 0.25 },
    FOUNDATION,
  );

  const base = new Vector3(center.x, padY, center.z);
  // 用途ごとの建て方。「9種を色違いの箱で出す」ことだけはしない —
  // 遠目に街を見たときに、住宅地と工業地とオフィス街が形で分かることが、
  // 3D で街を見せる理由そのものなので。
  switch (zone) {
    case 'residential':
      buildHouse(mb, lot, base, halfAlong, halfDepth, rand);
      break;
    case 'apartment':
      buildApartment(mb, lot, base, halfAlong, halfDepth, rand);
      break;
    case 'commercial':
      buildShop(mb, lot, base, halfAlong, halfDepth, rand);
      break;
    case 'office':
      buildOffice(mb, lot, base, halfAlong, halfDepth, rand);
      break;
    case 'farm':
      buildFarm(mb, lot, base, halfAlong, halfDepth, rand);
      break;
    case 'forestry':
      buildForestry(mb, lot, base, halfAlong, halfDepth, rand);
      break;
    case 'fishery':
      buildFishery(mb, lot, base, halfAlong, halfDepth, rand);
      break;
    case 'mining':
      buildMine(mb, lot, base, halfAlong, halfDepth, rand);
      break;
    default:
      buildFactory(mb, lot, base, halfAlong, halfDepth, rand);
      break;
  }
}

const UP = new Vector3(0, 1, 0);

function footprintCorner(center: Vector3, lot: Lot, along: number, out: number): Vector3 {
  return center.clone().addScaledVector(lot.along, along).addScaledVector(lot.outward, out);
}

/** 住宅。1〜2 階の切妻屋根で、道路側に玄関ポーチを付ける。 */
function buildHouse(
  mb: MeshBuilder,
  lot: Lot,
  base: Vector3,
  halfAlong: number,
  halfDepth: number,
  rand: () => number,
): void {
  const floors = rand() < 0.45 ? 1 : 2;
  const wall = floors * 2.85;
  const wallColor = pick(HOUSE_COLORS, rand);
  const roofColor = pick(ROOF_COLORS, rand);
  // 間口いっぱいには建てず、庭を残す。
  const hx = halfAlong * (0.72 + rand() * 0.18);
  const hz = halfDepth * (0.78 + rand() * 0.16);

  addBox(
    mb,
    base.clone().addScaledVector(UP, wall / 2),
    lot.along,
    UP,
    lot.outward,
    { x: hx, y: wall / 2, z: hz },
    wallColor,
  );
  addGableRoof(
    mb,
    base.clone().addScaledVector(UP, wall),
    lot,
    hx + 0.45,
    hz + 0.45,
    1.6 + rand() * 0.8,
    roofColor,
  );

  // 玄関ポーチ (道路側)。小さくても向きが分かる。
  const porchDepth = 1.1;
  addBox(
    mb,
    base
      .clone()
      .addScaledVector(UP, 1.15)
      .addScaledVector(lot.outward, -(hz + porchDepth / 2))
      .addScaledVector(lot.along, hx * (rand() < 0.5 ? -0.4 : 0.4)),
    lot.along,
    UP,
    lot.outward,
    { x: 1.2, y: 1.15, z: porchDepth / 2 },
    wallColor,
  );
}

/** 商業。低層の店舗ビル。1 階は間口いっぱいの店先、上に事務所が載る。 */
function buildShop(
  mb: MeshBuilder,
  lot: Lot,
  base: Vector3,
  halfAlong: number,
  halfDepth: number,
  rand: () => number,
): void {
  const floors = 2 + Math.floor(rand() * 3);
  const floorHeight = 3.5;
  const shop = 3.9;
  const upper = (floors - 1) * floorHeight;
  const wallColor = pick(OFFICE_COLORS, rand);
  const hx = halfAlong * (0.9 + rand() * 0.08);
  const hz = halfDepth * (0.86 + rand() * 0.12);

  // 1 階 (店先)。ガラス張りに見えるよう暗い色にする。
  addBox(
    mb,
    base.clone().addScaledVector(UP, shop / 2),
    lot.along,
    UP,
    lot.outward,
    { x: hx, y: shop / 2, z: hz },
    GLASS,
  );
  // 店先の上の看板帯。
  addBox(
    mb,
    base.clone().addScaledVector(UP, shop + 0.35).addScaledVector(lot.outward, -hz),
    lot.along,
    UP,
    lot.outward,
    { x: hx, y: 0.55, z: 0.22 },
    pick(ZONE_COLOR_LIST, rand),
  );
  // 上階。
  addBox(
    mb,
    base.clone().addScaledVector(UP, shop + upper / 2),
    lot.along,
    UP,
    lot.outward,
    { x: hx * 0.98, y: upper / 2, z: hz * 0.98 },
    wallColor,
  );
  // パラペットと塔屋。
  addBox(
    mb,
    base.clone().addScaledVector(UP, shop + upper + 0.3),
    lot.along,
    UP,
    lot.outward,
    { x: hx, y: 0.3, z: hz },
    CONCRETE,
  );
  addBox(
    mb,
    base.clone().addScaledVector(UP, shop + upper + 1.6),
    lot.along,
    UP,
    lot.outward,
    { x: hx * 0.3, y: 1.3, z: hz * 0.3 },
    CONCRETE,
  );
}

/** 工業。平屋の大きな建屋に、屋根の越屋根と煙突を載せる。 */
function buildFactory(
  mb: MeshBuilder,
  lot: Lot,
  base: Vector3,
  halfAlong: number,
  halfDepth: number,
  rand: () => number,
): void {
  const height = 6.5 + rand() * 2.5;
  const hx = halfAlong * (0.94 + rand() * 0.05);
  const hz = halfDepth * (0.9 + rand() * 0.08);
  const wallColor: RGB = [0.62, 0.63, 0.6];

  addBox(
    mb,
    base.clone().addScaledVector(UP, height / 2),
    lot.along,
    UP,
    lot.outward,
    { x: hx, y: height / 2, z: hz },
    wallColor,
  );
  // 越屋根 (明かり取り)。
  addBox(
    mb,
    base.clone().addScaledVector(UP, height + 0.8),
    lot.along,
    UP,
    lot.outward,
    { x: hx * 0.7, y: 0.8, z: hz * 0.45 },
    STEEL,
  );
  // シャッター (道路側)。
  addBox(
    mb,
    base.clone().addScaledVector(UP, 2.1).addScaledVector(lot.outward, -hz),
    lot.along,
    UP,
    lot.outward,
    { x: hx * 0.35, y: 2.1, z: 0.18 },
    [0.4, 0.42, 0.44],
  );
  // 煙突。
  addBox(
    mb,
    base
      .clone()
      .addScaledVector(UP, height * 0.75)
      .addScaledVector(lot.along, hx * 0.82)
      .addScaledVector(lot.outward, hz * 0.7),
    lot.along,
    UP,
    lot.outward,
    { x: 0.55, y: height * 0.75, z: 0.55 },
    CONCRETE,
  );
}

/**
 * 集合住宅。同じ間口の住戸を積んだ板状の棟に、廊下側と balcony 側を作る。
 *
 * 低密度住宅との違いが「高さ」だけだと、遠目には同じ街並みになってしまう。
 * 板状の棟・水平に通る廊下・並んだバルコニーという**別の形**を与えて、
 * 高密度住宅地が高密度に見えるようにする。
 */
function buildApartment(
  mb: MeshBuilder,
  lot: Lot,
  base: Vector3,
  halfAlong: number,
  halfDepth: number,
  rand: () => number,
): void {
  const floors = 4 + Math.floor(rand() * 4);
  const floorHeight = 2.9;
  const height = floors * floorHeight;
  const hx = halfAlong * (0.94 + rand() * 0.05);
  const hz = halfDepth * (0.76 + rand() * 0.1);
  const wallColor = pick(HOUSE_COLORS, rand);

  addBox(
    mb,
    base.clone().addScaledVector(UP, height / 2),
    lot.along,
    UP,
    lot.outward,
    { x: hx, y: height / 2, z: hz },
    wallColor,
  );

  // 各階のバルコニー (道路側)。1 本の帯にして、階数がそのまま見えるようにする。
  for (let floor = 1; floor < floors; floor++) {
    addBox(
      mb,
      base
        .clone()
        .addScaledVector(UP, floor * floorHeight + 0.5)
        .addScaledVector(lot.outward, -(hz + 0.5)),
      lot.along,
      UP,
      lot.outward,
      { x: hx * 0.92, y: 0.5, z: 0.5 },
      CONCRETE,
    );
  }
  // 妻側の階段室。板状の棟にはこれが要る。
  addBox(
    mb,
    base
      .clone()
      .addScaledVector(UP, (height + 1.4) / 2)
      .addScaledVector(lot.along, hx * (rand() < 0.5 ? -1 : 1)),
    lot.along,
    UP,
    lot.outward,
    { x: 1.6, y: (height + 1.4) / 2, z: hz * 0.55 },
    CONCRETE,
  );
  // 陸屋根のパラペットと塔屋。
  addBox(
    mb,
    base.clone().addScaledVector(UP, height + 0.35),
    lot.along,
    UP,
    lot.outward,
    { x: hx, y: 0.35, z: hz },
    CONCRETE,
  );
}

/** オフィス。ガラスの帯を積んだ塔。街のどこからでも business district が分かる。 */
function buildOffice(
  mb: MeshBuilder,
  lot: Lot,
  base: Vector3,
  halfAlong: number,
  halfDepth: number,
  rand: () => number,
): void {
  const floors = 6 + Math.floor(rand() * 7);
  const floorHeight = 3.6;
  const height = floors * floorHeight;
  const hx = halfAlong * (0.9 + rand() * 0.08);
  const hz = halfDepth * (0.86 + rand() * 0.1);

  // 躯体。ガラスの帯を挟むので、外壁は少し内側に。
  addBox(
    mb,
    base.clone().addScaledVector(UP, height / 2),
    lot.along,
    UP,
    lot.outward,
    { x: hx * 0.97, y: height / 2, z: hz * 0.97 },
    pick(OFFICE_COLORS, rand),
  );
  // 階ごとのガラス帯。1 層おきにすると、遠目に縞として読める。
  for (let floor = 0; floor < floors; floor += 1) {
    addBox(
      mb,
      base.clone().addScaledVector(UP, floor * floorHeight + floorHeight * 0.6),
      lot.along,
      UP,
      lot.outward,
      { x: hx, y: floorHeight * 0.3, z: hz },
      GLASS,
    );
  }
  // 頂部の設備階。
  addBox(
    mb,
    base.clone().addScaledVector(UP, height + 1.2),
    lot.along,
    UP,
    lot.outward,
    { x: hx * 0.55, y: 1.2, z: hz * 0.55 },
    CONCRETE,
  );
}

/**
 * 水田と作業小屋。
 *
 * 敷地のほとんどは**畑**で、建屋は隅の小屋。一次産業の敷地を「小さな工場」
 * として建てると、農地が街の中の工場地帯に見えてしまう。
 */
function buildFarm(
  mb: MeshBuilder,
  lot: Lot,
  base: Vector3,
  halfAlong: number,
  halfDepth: number,
  rand: () => number,
): void {
  // 水を張った田。薄い板を敷地いっぱいに敷く。
  addBox(
    mb,
    base.clone().addScaledVector(UP, 0.12),
    lot.along,
    UP,
    lot.outward,
    { x: halfAlong, y: 0.12, z: halfDepth },
    [0.35, 0.45, 0.3],
  );
  // 畦。田を何枚かに区切る。
  const strips = 2 + Math.floor(rand() * 2);
  for (let i = 1; i < strips; i++) {
    const at = -halfAlong + (2 * halfAlong * i) / strips;
    addBox(
      mb,
      base.clone().addScaledVector(UP, 0.3).addScaledVector(lot.along, at),
      lot.along,
      UP,
      lot.outward,
      { x: 0.25, y: 0.3, z: halfDepth },
      [0.5, 0.45, 0.36],
    );
  }
  // 作業小屋。奥の隅に寄せる。
  const shed = 3.4;
  addBox(
    mb,
    base
      .clone()
      .addScaledVector(UP, shed / 2)
      .addScaledVector(lot.along, halfAlong * 0.7 * (rand() < 0.5 ? -1 : 1))
      .addScaledVector(lot.outward, halfDepth * 0.66),
    lot.along,
    UP,
    lot.outward,
    { x: 2.6, y: shed / 2, z: 2.0 },
    [0.68, 0.66, 0.6],
  );
}

/** 林業。丸太を積み上げた土場と、製材の建屋。 */
function buildForestry(
  mb: MeshBuilder,
  lot: Lot,
  base: Vector3,
  halfAlong: number,
  halfDepth: number,
  rand: () => number,
): void {
  const height = 5.5 + rand() * 1.5;
  // 製材の建屋 (奥)。
  addBox(
    mb,
    base.clone().addScaledVector(UP, height / 2).addScaledVector(lot.outward, halfDepth * 0.5),
    lot.along,
    UP,
    lot.outward,
    { x: halfAlong * 0.6, y: height / 2, z: halfDepth * 0.42 },
    [0.6, 0.56, 0.5],
  );
  // 丸太の山 (道路側)。段ごとに 1 本ずつ減らして三角に積む。
  const stacks = 2 + Math.floor(rand() * 2);
  for (let stack = 0; stack < stacks; stack++) {
    const at = -halfAlong * 0.7 + (stack * halfAlong * 1.4) / Math.max(1, stacks - 1 || 1);
    for (let layer = 0; layer < 3; layer++) {
      addBox(
        mb,
        base
          .clone()
          .addScaledVector(UP, 0.45 + layer * 0.8)
          .addScaledVector(lot.along, at)
          .addScaledVector(lot.outward, -halfDepth * 0.45),
        lot.along,
        UP,
        lot.outward,
        { x: 1.6 - layer * 0.35, y: 0.4, z: 1.5 },
        [0.52, 0.38, 0.24],
      );
    }
  }
}

/** 漁港。岸へ向かって桟橋を伸ばし、陸側に番屋を置く。 */
function buildFishery(
  mb: MeshBuilder,
  lot: Lot,
  base: Vector3,
  halfAlong: number,
  halfDepth: number,
  rand: () => number,
): void {
  const height = 4.2 + rand();
  // 番屋。
  addBox(
    mb,
    base.clone().addScaledVector(UP, height / 2),
    lot.along,
    UP,
    lot.outward,
    { x: halfAlong * 0.7, y: height / 2, z: halfDepth * 0.5 },
    [0.66, 0.68, 0.7],
  );
  addGableRoof(
    mb,
    base.clone().addScaledVector(UP, height),
    lot,
    halfAlong * 0.75,
    halfDepth * 0.55,
    1.2,
    [0.3, 0.36, 0.42],
  );
  // 桟橋。敷地の奥 (水側) へ板を渡し、杭で支える。
  const deck = halfDepth * 0.9;
  addBox(
    mb,
    base.clone().addScaledVector(UP, 0.7).addScaledVector(lot.outward, halfDepth * 0.5 + deck / 2),
    lot.along,
    UP,
    lot.outward,
    { x: halfAlong * 0.35, y: 0.18, z: deck / 2 },
    [0.56, 0.48, 0.38],
  );
  for (let pile = 0; pile < 3; pile++) {
    addBox(
      mb,
      base
        .clone()
        .addScaledVector(UP, 0.35)
        .addScaledVector(lot.outward, halfDepth * 0.5 + (deck * (pile + 0.5)) / 3),
      lot.along,
      UP,
      lot.outward,
      { x: 0.2, y: 0.35, z: 0.2 },
      [0.42, 0.36, 0.3],
    );
  }
}

/** 鉱山。櫓 (headframe) とずり山。遠くからでも「掘っている」と分かる形。 */
function buildMine(
  mb: MeshBuilder,
  lot: Lot,
  base: Vector3,
  halfAlong: number,
  halfDepth: number,
  rand: () => number,
): void {
  // 巻き上げの建屋。
  addBox(
    mb,
    base.clone().addScaledVector(UP, 2.6).addScaledVector(lot.outward, halfDepth * 0.45),
    lot.along,
    UP,
    lot.outward,
    { x: halfAlong * 0.55, y: 2.6, z: halfDepth * 0.35 },
    [0.58, 0.55, 0.5],
  );
  // 櫓。4 本の脚と頭。
  const tower = 9 + rand() * 3;
  const spread = Math.min(2.4, halfAlong * 0.5);
  for (const [a, b] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ] as const) {
    addBox(
      mb,
      base
        .clone()
        .addScaledVector(UP, tower / 2)
        .addScaledVector(lot.along, a * spread)
        .addScaledVector(lot.outward, b * spread * 0.6 - halfDepth * 0.25),
      lot.along,
      UP,
      lot.outward,
      { x: 0.22, y: tower / 2, z: 0.22 },
      STEEL,
    );
  }
  addBox(
    mb,
    base.clone().addScaledVector(UP, tower).addScaledVector(lot.outward, -halfDepth * 0.25),
    lot.along,
    UP,
    lot.outward,
    { x: spread + 0.4, y: 0.9, z: spread * 0.6 + 0.4 },
    STEEL,
  );
  // ずり山。掘った土は敷地の隅に積む。
  addBox(
    mb,
    base
      .clone()
      .addScaledVector(UP, 1.4)
      .addScaledVector(lot.along, halfAlong * 0.7 * (rand() < 0.5 ? -1 : 1))
      .addScaledVector(lot.outward, halfDepth * 0.6),
    lot.along,
    UP,
    lot.outward,
    { x: 2.2, y: 1.4, z: 1.8 },
    [0.45, 0.4, 0.34],
  );
}

const ZONE_COLOR_LIST: RGB[] = [
  [0.82, 0.36, 0.3],
  [0.3, 0.52, 0.78],
  [0.86, 0.68, 0.28],
  [0.36, 0.62, 0.44],
];

/**
 * 切妻屋根。棟は道路と平行に通す。
 *
 * 面ごとに法線を求めて張るので、傾いた面でも陰影が正しく出る。
 */
function addGableRoof(
  mb: MeshBuilder,
  eaves: Vector3,
  lot: Lot,
  halfAlong: number,
  halfDepth: number,
  height: number,
  color: RGB,
): void {
  const corner = (along: number, out: number): Vector3 =>
    eaves.clone().addScaledVector(lot.along, along).addScaledVector(lot.outward, out);
  const b0 = corner(-halfAlong, -halfDepth);
  const b1 = corner(halfAlong, -halfDepth);
  const b2 = corner(halfAlong, halfDepth);
  const b3 = corner(-halfAlong, halfDepth);
  const r0 = corner(-halfAlong, 0).addScaledVector(UP, height);
  const r1 = corner(halfAlong, 0).addScaledVector(UP, height);
  const inside = eaves.clone().addScaledVector(UP, height * 0.4);

  addFace(mb, [b0, b1, r1, r0], color, inside);
  addFace(mb, [b2, b3, r0, r1], color, inside);
  addFace(mb, [b0, r0, b3], color, inside);
  addFace(mb, [b1, b2, r1], color, inside);
}

/**
 * 多角形の面を 1 枚張る。
 *
 * 法線は 3 点から求め、面の中心が `inside` から見て外を向くように整える。
 * 表裏を取り違えると、屋根が暗く落ち込んで見える。
 */
function addFace(mb: MeshBuilder, points: Vector3[], color: RGB, inside: Vector3): void {
  if (points.length < 3) return;
  const normal = new Vector3()
    .subVectors(points[1], points[0])
    .cross(new Vector3().subVectors(points[2], points[0]));
  if (normal.lengthSq() < 1e-12) return;
  normal.normalize();
  const centre = new Vector3();
  for (const p of points) centre.add(p);
  centre.divideScalar(points.length);
  const ordered = normal.dot(centre.clone().sub(inside)) < 0 ? [...points].reverse() : points;
  if (ordered !== points) normal.negate();

  const base = mb.vertexCount;
  for (const p of ordered) mb.vertex(p, normal, 0, 0, color);
  for (let i = 2; i < ordered.length; i++) mb.triangle(base, base + i - 1, base + i);
}

function pick<T>(list: T[], rand: () => number): T {
  return list[Math.min(list.length - 1, Math.floor(rand() * list.length))];
}

/** 決定論的な擬似乱数 (mulberry32)。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
