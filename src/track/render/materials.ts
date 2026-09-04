import {
  Color,
  DoubleSide,
  MeshStandardMaterial,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { applySurfaceNoise, type SurfaceNoiseOptions } from '../../look/surfaceNoise';

/** 表示モードを切り替えるための共有 uniform。 */
export const viewUniforms = {
  /** 1 で診断表示 (勾配・曲率の色分け) を有効にする。 */
  uDiagnostics: { value: 0 },
  /** 地形の等高線の間隔 [m]。0 で非表示。 */
  uContour: { value: 0 },
  /** 1 で地形を傾斜のヒートマップにする。 */
  uSlopeHeat: { value: 0 },
  /**
   * 水面の高さ [m]。砂浜はここを基準に出す。
   *
   * 以前は「高さ 0 から 2.2m までが砂」という決め打ちで、水面が 0 でない
   * この世界では湖のまわり一帯が巨大な砂地になっていた。
   */
  uWaterLevel: { value: 0 },
};

/**
 * 診断色のランプ。0 = 余裕、1 = 規格ちょうど、1.4 以上 = 大幅超過。
 *
 * シェーダと HUD の数値で同じ配色を使うため、ここ 1 か所に置いて
 * GLSL へは文字列として埋め込む。
 */
const RISK_OK = [0.24, 0.72, 0.36] as const;
const RISK_WARN = [0.95, 0.79, 0.2] as const;
const RISK_BAD = [0.9, 0.22, 0.18] as const;

const glsl = (rgb: readonly [number, number, number]): string =>
  `vec3(${rgb.map((v) => v.toFixed(2)).join(', ')})`;

/** 診断色 (0..1 の RGB)。シェーダの `riskColor` と同じ計算。 */
export function riskTint(risk: number): readonly [number, number, number] {
  const t = risk < 0.75 ? risk / 0.75 : Math.min(1, Math.max(0, (risk - 0.75) / 0.45));
  const from = risk < 0.75 ? RISK_OK : RISK_WARN;
  const to = risk < 0.75 ? RISK_WARN : RISK_BAD;
  const at = (i: number): number => Math.min(1, Math.max(0, from[i] + (to[i] - from[i]) * t));
  return [at(0), at(1), at(2)];
}

/** 診断色を CSS の `#rrggbb` で返す。 */
export function riskColor(risk: number): string {
  const hex = (v: number): string =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, '0');
  const [r, g, b] = riskTint(risk);
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/**
 * 診断表示 (勾配・曲率) を注入したマテリアルを作る。
 *
 * 各頂点の `diag` は (勾配の規格比, 曲率の規格比)。1 を超えると規格超過なので
 * 緑 → 黄 → 赤へ変化させる。
 */
export function createSurfaceMaterial(options?: {
  transparent?: boolean;
  opacity?: number;
  depthWrite?: boolean;
  /** false にすると、何かの陰に入っていても必ず描かれる (透視表示)。 */
  depthTest?: boolean;
  polygonOffsetUnits?: number;
  side?: typeof DoubleSide | undefined;
  /** 診断表示の on/off を制御する uniform。既定は全体共有のもの。 */
  diagnostics?: { value: number };
  /** 1 にすると面を赤く塗る (敷設できないプレビュー)。 */
  blocked?: { value: number };
}): MeshStandardMaterial {
  const material = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.94,
    metalness: 0.0,
    transparent: options?.transparent ?? false,
    opacity: options?.opacity ?? 1,
    depthWrite: options?.depthWrite ?? true,
    depthTest: options?.depthTest ?? true,
    polygonOffset: true,
    // 傾き係数は 0 にする。視線に対して浅い角度で見た面では傾き係数の項が
    // 巨大になり、路面が数十 cm 手前に寄ってしまう。踏切のレールのように
    // 路面のすぐ上にあるものが、その分だけ舗装に飲まれて消えてしまう。
    polygonOffsetFactor: 0,
    polygonOffsetUnits: options?.polygonOffsetUnits ?? -2,
    ...(options?.side ? { side: options.side } : {}),
  });

  const blocked = options?.blocked ?? { value: 0 };
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    shader.uniforms.uDiagnostics = options?.diagnostics ?? viewUniforms.uDiagnostics;
    shader.uniforms.uBlocked = blocked;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec2 diag;
varying vec2 vDiag;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vDiag = diag;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uDiagnostics;
uniform float uBlocked;
varying vec2 vDiag;

vec3 riskColor(float risk) {
  // 0 = 余裕, 1 = 規格ちょうど, 1.4 以上 = 大幅超過。
  vec3 ok = ${glsl(RISK_OK)};
  vec3 warn = ${glsl(RISK_WARN)};
  vec3 bad = ${glsl(RISK_BAD)};
  if (risk < 0.75) return mix(ok, warn, risk / 0.75);
  return mix(warn, bad, clamp((risk - 0.75) / 0.45, 0.0, 1.0));
}`,
      )
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
if (uDiagnostics > 0.5) {
  float risk = max(vDiag.x, vDiag.y);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, riskColor(risk), 0.82);
}
if (uBlocked > 0.5) {
  gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.92, 0.22, 0.18), 0.85);
}`,
      );
  };
  // 透けるプレビューにはノイズを掛けない (半透明の板がざらつくと、
  // 敷ける／敷けないの色が読みにくくなるだけ)。
  const noised = !(options?.transparent ?? false);
  if (noised) addSurfaceNoise(material, ASPHALT_NOISE);

  // uniform の束ね方が違うマテリアル同士でプログラムを共有しないよう、
  // 診断 uniform を差し替えた場合はキーも変える。ノイズの有無も同じ理由で
  // キーに入れる -- 入れないと、ノイズ入りと素の材質が同じコンパイル済み
  // プログラムを共有して、どちらか一方の差し込みが黙って効かなくなる。
  const key = (options?.diagnostics ? 'surface-diag-forced' : 'surface-diag')
    + (noised ? ':noise' : '');
  material.customProgramCacheKey = () => key;
  return material;
}

/**
 * 地形マテリアル。傾斜による色分け、標高による色味、等高線を入れる。
 */
export function createTerrainMaterial(): MeshStandardMaterial {
  const material = new MeshStandardMaterial({
    color: new Color(1, 1, 1),
    roughness: 1.0,
    metalness: 0.0,
  });

  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    shader.uniforms.uContour = viewUniforms.uContour;
    shader.uniforms.uSlopeHeat = viewUniforms.uSlopeHeat;
    shader.uniforms.uWaterLevel = viewUniforms.uWaterLevel;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vWorldPos;
varying vec3 vWorldNormal;`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vWorldNormal = normalize(mat3(modelMatrix) * objectNormal);`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uContour;
uniform float uSlopeHeat;
uniform float uWaterLevel;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;

vec3 slopeHeat(float slopeDeg) {
  vec3 flat0 = vec3(0.16, 0.52, 0.78);
  vec3 mid = vec3(0.98, 0.85, 0.30);
  vec3 steep = vec3(0.85, 0.17, 0.20);
  float t = clamp(slopeDeg / 45.0, 0.0, 1.0);
  return t < 0.5 ? mix(flat0, mid, t * 2.0) : mix(mid, steep, (t - 0.5) * 2.0);
}

// ------- 地面の色 (移植先で足した: 移植元 claude-web-test-21 の groundPalette) -------
//
// 以前はここが「標高と傾斜で 5 色を混ぜる」だけで、平野が丸ごと 1 色の
// オリーブになっていた。見下ろしのゲームでは画面の大半が地面なので、
// そこに情報が 1 つも無いと、建物をどれだけ作り込んでも絵が完成しない。
//
// 層は 4 つ。標高で草の質を変え、乾湿のまだらを乗せ、乾ききった所は
// 土を透かし、急斜面と水際で素材そのものを変える。まだらは**世界座標の
// ノイズ**から引くので、メッシュをどう割っても模様は連続する。
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

vec3 terrainColor(float slopeDeg, float height, vec2 world) {
  // 草。低地は水気のある緑、台地は乾いて灰色寄り。標高だけで決めると
  // 平野が 1 色になるので、ノイズを混ぜて境目を溶かす。
  vec3 grassLow = vec3(0.435, 0.549, 0.322);
  vec3 grassHigh = vec3(0.494, 0.541, 0.361);
  vec3 grassDry = vec3(0.553, 0.529, 0.376);
  vec3 grassWet = vec3(0.353, 0.478, 0.275);
  vec3 soil = vec3(0.541, 0.455, 0.322);
  vec3 rock = vec3(0.420, 0.404, 0.365);
  vec3 sand = vec3(0.784, 0.722, 0.580);

  float n1 = valueNoise(world * 0.011);
  float n2 = valueNoise(world * 0.043 + 31.7);
  float mottle = clamp(n1 * 0.65 + n2 * 0.35, 0.0, 1.0);

  float alt = clamp(height / 90.0 + (mottle - 0.5) * 0.4, 0.0, 1.0);
  vec3 c = mix(grassLow, grassHigh, alt);

  // 乾湿。中点からの距離で両側へ振る。片側ずつ足すと、ノイズの実レンジに
  // 対して傾きが急すぎて片方が飽和し、2 素材あるのに 1 色しか出ない。
  float dry = clamp((mottle - 0.35) / 0.4, 0.0, 1.0);
  c = dry > 0.5
    ? mix(c, grassDry, (dry - 0.5) * 2.0 * 0.8)
    : mix(c, grassWet, (0.5 - dry) * 2.0 * 0.72);

  // 乾ききった所は地肌が透ける。明度ではなく素材を混ぜるので、
  // 引きの画でも「色の違う土地」として読める。
  float scalp = clamp((dry - 0.72) * 3.4, 0.0, 1.0);
  c = mix(c, soil, scalp * 0.3);

  // 傾斜。地形分類ではなく傾斜で決めるのが肝で、「山地」ではない急斜面
  // (河岸段丘・丘の縁) にも岩が出る。ノイズを足すのは、傾斜だけだと
  // 平らな山頂が一面の同じ灰色になり、巨大な板に見えるため。
  float bare = clamp((slopeDeg - 24.0) / 26.0 + (mottle - 0.5) * 0.44, 0.0, 1.0);
  c = mix(c, soil, smoothstep(0.0, 0.55, bare) * 0.55);
  c = mix(c, rock, smoothstep(0.45, 1.0, bare) * 0.85);

  // 水際だけ砂浜にする。水面からの高さで見るので、水面が 0 でない世界でも
  // 帯の幅は変わらない。
  c = mix(sand, c, smoothstep(0.0, 2.4, height - uWaterLevel));

  // 上の定数は sRGB の 16 進をそのまま小数にしたもの。ここはリニア空間なので
  // 変換して返す。省くと地面が 2 倍以上明るくなり、環境マップを足した途端に
  // 一面が白茶けたミント色になる (実際そうなった)。
  return pow(c, vec3(2.2));
}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  float slopeDeg = degrees(acos(clamp(normalize(vWorldNormal).y, -1.0, 1.0)));
  vec3 base = terrainColor(slopeDeg, vWorldPos.y, vWorldPos.xz);
  base = mix(base, slopeHeat(slopeDeg), uSlopeHeat);

  if (uContour > 0.0) {
    float major = uContour;
    float minorStep = major / 5.0;
    float dh = fwidth(vWorldPos.y) + 1e-4;
    float fMajor = abs(fract(vWorldPos.y / major - 0.5) - 0.5) * major;
    float fMinor = abs(fract(vWorldPos.y / minorStep - 0.5) - 0.5) * minorStep;
    float lineMajor = 1.0 - smoothstep(0.0, dh * 1.5, fMajor);
    float lineMinor = 1.0 - smoothstep(0.0, dh * 1.2, fMinor);
    base = mix(base, base * 0.72, lineMinor * 0.5);
    base = mix(base, base * 0.5, lineMajor * 0.7);
  }
  diffuseColor.rgb *= base;
}`,
      );
  };
  material.customProgramCacheKey = () => 'terrain-slope';
  return material;
}

/**
 * 既にシェーダを差し込んである材質へ、さらに路面ノイズを重ねる (移植先で足した)。
 *
 * `applySurfaceNoise` は `onBeforeCompile` を**上書き**するので、そのまま
 * 呼ぶと診断表示の差し込みが消える。両方を順に呼ぶ形に包み直し、
 * プログラムのキャッシュキーも 2 つ分を繋いでおく (片方だけ違う材質同士で
 * コンパイル済みプログラムを共有すると、片方の差し込みが効かなくなる)。
 */
function addSurfaceNoise(material: MeshStandardMaterial, options: SurfaceNoiseOptions): void {
  const firstHook = material.onBeforeCompile;
  const firstKey = material.customProgramCacheKey;
  applySurfaceNoise(material, options);
  const noiseHook = material.onBeforeCompile;
  const noiseKey = material.customProgramCacheKey;
  material.onBeforeCompile = (shader, renderer) => {
    firstHook.call(material, shader, renderer);
    noiseHook.call(material, shader, renderer);
  };
  material.customProgramCacheKey = () =>
    `${firstKey.call(material)}|${noiseKey.call(material)}`;
}

/**
 * 舗装のざらつき。
 *
 * 路面が一色の板に見える原因は、モデルの粗さではなく**1 つの面の中に情報が
 * 1 つも無いこと**にある。眼の高さでは画面の 3〜4 割が路面なので、そこが
 * 一色だとカット全体が未完成に見える。値は移植元のまま。
 */
const ASPHALT_NOISE: SurfaceNoiseOptions = {
  scale: 3.4,
  color: 0.14,
  roughness: 0.2,
  bump: 0.05,
  fade: 240,
  // 舗装の打ち継ぎ。4.6m は 1 車線ぶんの敷き幅。
  seam: { spacing: 4.6, width: 0.17, darken: 0.13 },
  // 環境マップは遮蔽を持たないので、街路の路面が「見渡す限りの空」を
  // 映してしまい、反射率 3% のアスファルトが 27% の明るさで描かれる。
  // 上を向いた面の間接鏡面だけ落とすのが、いちばん安い近似。
  specular: 0.2,
};

/** 路面標示など、路面のすぐ上に重ねる薄い面のマテリアル。 */
export function createOverlayMaterial(): MeshStandardMaterial {
  const material = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.8,
    metalness: 0.0,
    polygonOffset: true,
    polygonOffsetFactor: 0,
    polygonOffsetUnits: -8,
  });
  return material;
}

/** 構造物・小物用。両面表示にしてトンネル内側も見えるようにする。 */
export function createPropMaterial(): MeshStandardMaterial {
  return new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.85,
    metalness: 0.05,
    side: DoubleSide,
  });
}

/** 敷設できないプレビューを赤く塗るための uniform。 */
const previewBlocked = { value: 0 };

/*
 * プレビューの濃さ。
 *
 * プレビューは 2 枚重ねで描く (`createPreviewXrayMaterial` を参照)。
 * 隠れている所は透視用の 1 枚だけなので `XRAY` の濃さで薄く透け、地表に
 * 出ている所は 2 枚が重なって
 *   xray + surface - xray * surface
 * の濃さになる。これが `VISIBLE` ちょうどになるよう上に重ねる 1 枚を
 * 逆算するので、見えている所の濃さは 1 枚だった頃と変わらない。
 */

/** 隠れている所 (透視用の 1 枚だけ) の濃さ。 */
const PREVIEW_XRAY_OPACITY = { open: 0.4, blocked: 0.52 };
/** 見えている所 (2 枚重ね) の濃さ。 */
const PREVIEW_VISIBLE_OPACITY = { open: 0.75, blocked: 0.9 };

/** 透視用の 1 枚に重ねて `visible` の濃さになる、上の 1 枚の不透明度。 */
function overlayOpacity(visible: number, xray: number): number {
  return (visible - xray) / (1 - xray);
}

const PREVIEW_OPACITY = {
  open: overlayOpacity(PREVIEW_VISIBLE_OPACITY.open, PREVIEW_XRAY_OPACITY.open),
  blocked: overlayOpacity(PREVIEW_VISIBLE_OPACITY.blocked, PREVIEW_XRAY_OPACITY.blocked),
};

/**
 * 建設プレビュー用の半透明マテリアル。規格違反がすぐ分かるよう、
 * 全体設定にかかわらず常に診断色で表示する。
 */
export function createPreviewMaterial(): MeshStandardMaterial {
  return createSurfaceMaterial({
    transparent: true,
    opacity: PREVIEW_OPACITY.open,
    depthWrite: false,
    polygonOffsetUnits: -16,
    diagnostics: { value: 1 },
    blocked: previewBlocked,
  });
}

/**
 * 隠れたプレビューを透かして出すためのマテリアル。
 *
 * 深度試験をしないので、トンネルのように地形の下へ潜る線形も、丘の陰に
 * 入った線形も必ず描かれる。`createPreviewMaterial` の面より**先に**
 * 描いて (renderOrder を小さくする)、見えている所はその上から塗り直す。
 * こうすると、地表に出ている所は今までどおりの濃さで、隠れている所だけが
 * 薄く透けて見える。裏から見ることになるので両面表示にする。
 */
export function createPreviewXrayMaterial(): MeshStandardMaterial {
  return createSurfaceMaterial({
    transparent: true,
    opacity: PREVIEW_XRAY_OPACITY.open,
    depthWrite: false,
    depthTest: false,
    polygonOffsetUnits: -16,
    side: DoubleSide,
    diagnostics: { value: 1 },
    blocked: previewBlocked,
  });
}

/**
 * 敷設できないときのプレビュー表示。
 * 診断色より優先して赤く塗るので、置けないことが一目で分かる。
 */
export function setPreviewBlocked(
  materials: { preview: MeshStandardMaterial; xray: MeshStandardMaterial },
  blocked: boolean,
): void {
  previewBlocked.value = blocked ? 1 : 0;
  materials.preview.opacity = blocked ? PREVIEW_OPACITY.blocked : PREVIEW_OPACITY.open;
  materials.xray.opacity = blocked ? PREVIEW_XRAY_OPACITY.blocked : PREVIEW_XRAY_OPACITY.open;
}
