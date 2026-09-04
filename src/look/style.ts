import { Facade } from './buildingParts';

/**
 * The building styles the shape recipes read.
 *
 * Lifted out of the source's `theme.ts`, which was mostly a palette keyed to
 * that game's own zone and terrain enums. These two declarations are the part
 * the shape library actually depends on, and they say nothing about zones --
 * so they come across whole and the rest stays behind.
 */

/**
 * 建物の形状キーごとの造形パラメータ。
 *
 * 以前は「色・高さ・屋根の形」の 3 つしか無く、どの用途も 1 つの箱に
 * 屋根が載るだけだった。ここに**階高・スパン・立面の様式・量塊のバリエーション**を
 * 足すと、同じ描画コードのまま用途ごとの顔が出せるようになる。
 *
 * - `floorH` / `bay` は窓の格子の刻み。実際の階高（住宅 2.9m、事務所 3.6m、
 *   工場 5m 前後）に合わせてあるので、隣り合う建物の窓の高さが揃い、
 *   街並みとして自然に見える。
 * - `walls` / `roofs` は候補の配列。棟ごとにハッシュで 1 つ選び、
 *   さらに `jitterColor` で散らす。「同じ色の箱の整列」が消える。
 */
export interface MeshStyle {
  /** 壁の色の候補。棟ごとにハッシュで選ぶ。 */
  walls: number[];
  /** 屋根の色の候補。 */
  roofs: number[];
  /** 立面の様式（`Facade.*`）。 */
  facade: number;
  /** 階高 (m)。窓の格子はこの高さで刻む。 */
  floorH: number;
  /** 窓のスパン (m)。 */
  bay: number;
  /** レベル 1 の高さ (m)。 */
  baseHeight: number;
  /** レベルごとの追加高さ (m)。 */
  perLevel: number;
  /**
   * 屋根の形。
   *
   * 日本の街並みは切妻・寄棟・陸屋根の混在で出来ている。
   * 陸屋根には必ずパラペットと屋上設備が載るので、`Flat` は
   * 「何も無い平らな面」ではなく「情報量の多い面」を意味する。
   */
  roofKind: RoofKind;
  /** 敷地に対する建物の占有率。小さいほど庭・空地が見える。 */
  inset: number;
  /** 量塊のバリエーション数（ハッシュで選ぶ）。 */
  variants: number;
}

/** 屋根の形。`none` は屋上に何も載せない（背の低い農地・公園など）。 */
export const RoofKind = {
  None: 'none',
  /** 切妻。棟が 1 本通る、日本の住宅でいちばん多い形。 */
  Gable: 'gable',
  /** 寄棟（方形）。4 方向に流れる。 */
  Hip: 'hip',
  /** 陸屋根。平らな屋上にパラペット（立ち上がり）を回す。 */
  Flat: 'flat',
} as const;
export type RoofKind = (typeof RoofKind)[keyof typeof RoofKind];



const style = (o: Partial<MeshStyle> & { walls: number[] }): MeshStyle => ({
  roofs: [0x4a4f56],
  facade: Facade.Residential,
  floorH: 3.0,
  bay: 2.6,
  baseHeight: 6,
  perLevel: 3,
  roofKind: RoofKind.None,
  inset: 0.78,
  variants: 1,
  ...o,
});


/**
 * 日本の住宅でよく見る外壁（サイディング・モルタル）の色。
 *
 * 候補は多いほどよい。ここから 1 つ選んだあと `buildingLayer` が
 * 色相 ±8°・明度 ±12%・彩度 ±20% を棟ハッシュで散らすので、
 * 実際に街に出る色は候補数 × ハッシュのぶんだけある。
 * 候補が数個しかないと、散らしても「元の色のグループ」が目で読めてしまう。
 */
const HOUSE_WALLS = [
  0xd8ccb0, 0xc9c0a4, 0xbfbcb0, 0xd4c39c, 0xb0bcc0, 0xc6b294, 0xdcd6c4, 0xa89c88, 0xbfa88c,
  0xe0dcd2, 0xc8ccc2, 0xb8a898, 0xd0b8a0, 0xa8b09c, 0xcfc0b4, 0xbcae9e, 0xd6cec0, 0x9aa4a2,
  // 濃いサイディング（灰・こげ茶・紺鼠）。明るい色ばかりだと住宅地が
  // 「白い箱の反復」に見える。全体の 2 割ほど濃い壁が混ざるだけで密度が出る。
  0x8f8a80, 0x9c8f7c, 0x7f8a8e, 0x8a7f74,
];
/**
 * 屋根の色。
 *
 * 青灰のスレートだけにすると、住宅地を拡大したときに
 * 「青灰色の切妻＋白い壁」がグリッド上に反復しているのが露骨に読める。
 * 日本の屋根は実際には 4 系統が混ざっているので、それぞれを候補に入れる。
 * 先頭 8 つがスレート（約 57%）、以降がセメント瓦・和瓦・トタンで各 14% 前後。
 */
const HOUSE_ROOFS = [
  // 化粧スレート（青灰〜灰）
  0x5a6670, 0x4e5459, 0x3e4952, 0x546069, 0x646e78, 0x49535c, 0x5f6a6e, 0x464b4d,
  // セメント瓦（茶灰）
  0x6b5f4e, 0x776a58,
  // 和瓦（銀黒・いぶし）
  0x3a3e44, 0x2f333a,
  // トタン（緑・赤錆）
  0x4a6b52, 0x7a4f3e,
];

/**
 * 金属葺き（トタン）の屋根色。
 * 瓦やスレートより光るので、粗さと金属度を分けて渡す。
 * 同じ形の切妻でも、鈍く光る屋根が 1 割混ざるだけで街のざらつきが変わる。
 */

export const TIN_ROOFS = new Set([0x4a6b52, 0x7a4f3e]);
/** コンクリート・タイル貼りの中高層。 */
const RC_WALLS = [
  0xc6bca4, 0xb6ae9c, 0xcfc9ba, 0xa8b0b0, 0xbdae92, 0xc8c4bc, 0x9c968a, 0xb8a894,
  0xd2ccc0, 0xaeb6b8, 0xc0b09a, 0xd6d0c4, 0xa4a09a, 0xbec6c6, 0xcab89e, 0xb0a08e,
  // 濃いタイル貼り。明るいコンクリートばかりだと、中層の街区が
  // 「淡青灰とクリームの 2 色」に見えてしまう。
  0x8f8b82, 0x7f8a90, 0x9a8a76, 0x8e8c88,
];

export const MESH_STYLES: Record<string, MeshStyle> = {
  // ---- 住宅 ----
  house: style({
    walls: HOUSE_WALLS,
    roofs: HOUSE_ROOFS,
    facade: Facade.Residential,
    floorH: 2.85,
    bay: 2.1,
    baseHeight: 5.7,
    perLevel: 1.6,
    roofKind: RoofKind.Gable,
    inset: 0.6,
    variants: 4,
  }),
  apartment: style({
    walls: [
      0xd2c8ac, 0xc4ba9c, 0xd8d2c0, 0xb6bcb8, 0xc8b494, 0xbaa88c,
      0xdcd8cc, 0xaeb4ae, 0xcbb8a4, 0xc0c4c0, 0xd4c0a8, 0xa8a094,
      0x9c968c, 0x8fa0a4, 0x9a8f80,
    ],
    roofs: HOUSE_ROOFS,
    facade: Facade.Residential,
    floorH: 2.85,
    bay: 3.2,
    baseHeight: 8.55,
    perLevel: 2.85,
    roofKind: RoofKind.Gable,
    inset: 0.72,
    variants: 3,
  }),
  mansion: style({
    walls: RC_WALLS,
    roofs: [0x9c9a95],
    facade: Facade.Residential,
    floorH: 3.0,
    bay: 3.3,
    baseHeight: 15,
    perLevel: 6,
    roofKind: RoofKind.Flat,
    inset: 0.82,
    // 最上階セットバック・段違い・独立した階段室ボックスを引けるようにする。
    // 同じ押し出し箱が並ぶのがスカイラインの鋸歯の正体なので、
    // 中高層ほど量塊の候補を増やす。
    variants: 4,
  }),
  tower: style({
    walls: [0xc8ccd2, 0xbfc6ce, 0xd2d6da, 0xb4bcc6, 0xdcdee0, 0xc0c8c4, 0xcac4ba],
    roofs: [0x9aa0a8],
    facade: Facade.Curtain,
    floorH: 3.2,
    bay: 3.4,
    baseHeight: 48,
    perLevel: 14,
    roofKind: RoofKind.Flat,
    inset: 0.66,
    variants: 2,
  }),
  // ---- 商業 ----
  konbini: style({
    walls: [0xf2f2ee, 0xeceae2],
    roofs: [0xcfcdc6],
    facade: Facade.Shop,
    floorH: 3.6,
    bay: 2.6,
    baseHeight: 5.2,
    perLevel: 1.5,
    roofKind: RoofKind.Flat,
    inset: 0.7,
    variants: 2,
  }),
  shotengai: style({
    walls: [
      0xdcc4a0, 0xcfbca4, 0xe0d4bc, 0xc2b096, 0xd4bd94, 0xb8a894,
      0xc8b8a8, 0xd8cbb0, 0xb0a894, 0xcfc2ae, 0xc4a888, 0xe2dac8,
    ],
    roofs: [0x9c6f56, 0x7d6a56, 0x5e6a72, 0x8a7a5e],
    facade: Facade.Shop,
    floorH: 3.1,
    bay: 2.4,
    baseHeight: 6.5,
    perLevel: 3.1,
    roofKind: RoofKind.Gable,
    inset: 0.92,
    variants: 3,
  }),
  supermarket: style({
    walls: [0xdcd8c8, 0xd2cebe],
    roofs: [0xc6c3ba],
    facade: Facade.Shop,
    floorH: 4.4,
    bay: 3.4,
    baseHeight: 8.8,
    perLevel: 2,
    roofKind: RoofKind.Flat,
    inset: 0.88,
    variants: 2,
  }),
  zakkyo: style({
    walls: [
      0xc4bcaa, 0xb0aa9c, 0xccc6b8, 0xa4aeb2, 0xbcac90, 0x94989a, 0xc0a88c,
      0xd2ccbe, 0x9ea6a8, 0xb8b0a0, 0xc8bca8, 0xa89c8c, 0xbec4c2, 0xd0c0a8,
    ],
    roofs: [0xa8a49b],
    facade: Facade.Shop,
    floorH: 3.3,
    bay: 2.5,
    baseHeight: 13.5,
    perLevel: 6.6,
    roofKind: RoofKind.Flat,
    inset: 0.86,
    variants: 4,
  }),
  office: style({
    walls: [
      0xa9b4c0, 0xb4bcc4, 0x9ea8b2, 0xc0c4c4, 0x8f9aa4, 0xb8b4ac, 0xa4aa9e, 0xcac6bc,
    ],
    roofs: [0x99a3ad],
    facade: Facade.Curtain,
    floorH: 3.6,
    bay: 3.0,
    baseHeight: 25.2,
    perLevel: 10.8,
    roofKind: RoofKind.Flat,
    inset: 0.84,
    variants: 5,
  }),
  // ---- 工業 ----
  smallfactory: style({
    walls: [0xb4afa0, 0xa8a498, 0xbcb8ac, 0x9ca4a6, 0xa89c88],
    roofs: [0x9a8a70, 0x848c92, 0x6e7278],
    facade: Facade.Industrial,
    floorH: 4.2,
    bay: 3.0,
    baseHeight: 6.3,
    perLevel: 2,
    roofKind: RoofKind.Gable,
    inset: 0.8,
    variants: 3,
  }),
  factory: style({
    walls: [0xa09a8c, 0xaca89c, 0x929a9c],
    roofs: [0x77726a],
    facade: Facade.Industrial,
    floorH: 5.5,
    bay: 3.6,
    baseHeight: 11,
    perLevel: 4,
    roofKind: RoofKind.Flat,
    inset: 0.88,
    variants: 2,
  }),
  sawmill: style({
    walls: [0xa08e72, 0x9c8b6f, 0xb0a488],
    roofs: [0x87735a],
    facade: Facade.Industrial,
    floorH: 4.5,
    bay: 3.2,
    baseHeight: 9,
    perLevel: 3,
    roofKind: RoofKind.Gable,
    inset: 0.86,
    variants: 2,
  }),
  ricemill: style({
    walls: [0xd2cab4, 0xc6c0ae],
    roofs: [0x6b665c],
    facade: Facade.Industrial,
    floorH: 4.4,
    bay: 3.2,
    baseHeight: 8.8,
    perLevel: 3,
    roofKind: RoofKind.Flat,
    inset: 0.86,
    variants: 2,
  }),
  warehouse: style({
    walls: [0xa8a498, 0x9ca09c, 0xb0aca0],
    roofs: [0x77726a],
    facade: Facade.Industrial,
    floorH: 5.0,
    bay: 3.6,
    baseHeight: 8,
    perLevel: 2,
    roofKind: RoofKind.Flat,
    inset: 0.92,
    variants: 2,
  }),
  // ---- 農林（地面の色が主役なので、造形は畦と畝だけ）----
  paddy: style({ walls: [0x7a6a52], baseHeight: 0.3, perLevel: 0, inset: 0.98 }),
  field: style({ walls: [0x8a6f4e], baseHeight: 0.3, perLevel: 0, inset: 0.96 }),
  forestry: style({ walls: [0x36703f], baseHeight: 3.5, perLevel: 0, inset: 0.9 }),
  // ---- 公共 ----
  station: style({
    walls: [0xe2e6ea, 0xd8dee4],
    roofs: [0x54687e, 0x46586a],
    facade: Facade.Institution,
    floorH: 4.0,
    bay: 2.8,
    baseHeight: 8,
    perLevel: 0,
    roofKind: RoofKind.Hip,
    inset: 0.62,
    variants: 2,
  }),
  school: style({
    walls: [0xdcd4bc, 0xd0cab4],
    roofs: [0x74858e],
    facade: Facade.Institution,
    floorH: 3.6,
    bay: 2.4,
    baseHeight: 11.5,
    perLevel: 0,
    roofKind: RoofKind.Flat,
    inset: 0.94,
    variants: 1,
  }),
  hospital: style({
    walls: [0xf0f0ee, 0xe6e8ea],
    roofs: [0xb9bcbe],
    facade: Facade.Institution,
    floorH: 3.5,
    bay: 2.6,
    baseHeight: 14,
    perLevel: 0,
    roofKind: RoofKind.Flat,
    inset: 0.86,
    variants: 3,
  }),
  police: style({
    walls: [0xd8dee8, 0xccd4de],
    roofs: [0x4e6288],
    facade: Facade.Institution,
    floorH: 3.4,
    bay: 2.4,
    baseHeight: 6.8,
    perLevel: 0,
    roofKind: RoofKind.Flat,
    inset: 0.7,
    variants: 2,
  }),
  fire: style({
    walls: [0xe6b8b0, 0xdcaea6],
    roofs: [0x6b3a3a],
    facade: Facade.Institution,
    floorH: 3.8,
    bay: 2.6,
    baseHeight: 9.5,
    perLevel: 0,
    roofKind: RoofKind.Flat,
    inset: 0.82,
    variants: 2,
  }),
  park: style({ walls: [0x6fbf6f], baseHeight: 1.2, perLevel: 0, inset: 0.95 }),
  shrine: style({
    walls: [0xc4553f, 0xb84f3c],
    roofs: [0x4a4e56, 0x3f4a52],
    facade: Facade.Plain,
    baseHeight: 4.6,
    perLevel: 0,
    roofKind: RoofKind.Hip,
    inset: 0.8,
    variants: 1,
  }),
  cityhall: style({
    walls: [0xdad6ca, 0xd0ccc0],
    roofs: [0x5c6a78],
    facade: Facade.Institution,
    floorH: 3.8,
    bay: 2.6,
    baseHeight: 15.2,
    perLevel: 0,
    roofKind: RoofKind.Flat,
    inset: 0.88,
    variants: 1,
  }),
  // ---- インフラ ----
  powerplant: style({
    walls: [0x9aa0a4, 0xa6acaa],
    roofs: [0x76797c],
    facade: Facade.Industrial,
    floorH: 6.0,
    bay: 4.0,
    baseHeight: 24,
    perLevel: 0,
    roofKind: RoofKind.Flat,
    inset: 0.9,
    variants: 1,
  }),
  solar: style({ walls: [0x2b3a54], baseHeight: 0.8, perLevel: 0, inset: 0.94 }),
  waterworks: style({
    walls: [0xc9d3d8, 0xbfcad0],
    roofs: [0x8fa0a8],
    facade: Facade.Institution,
    floorH: 3.6,
    bay: 2.6,
    baseHeight: 7.2,
    perLevel: 0,
    roofKind: RoofKind.Flat,
    inset: 0.9,
    variants: 1,
  }),
  sewage: style({
    walls: [0xafb6aa, 0xa4aca0],
    roofs: [0x7d8478],
    facade: Facade.Institution,
    floorH: 3.6,
    bay: 2.6,
    baseHeight: 6.0,
    perLevel: 0,
    roofKind: RoofKind.Flat,
    inset: 0.92,
    variants: 1,
  }),
};

export function meshStyle(key: string): MeshStyle {
  return MESH_STYLES[key] ?? MESH_STYLES.house!;
}
