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

