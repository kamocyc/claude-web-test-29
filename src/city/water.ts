import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Mesh,
  Object3D,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector3,
} from 'three';
import type { Heightfield } from '../track/terrain/heightfield';
import type { Atmosphere } from '../look/sky';
import { WATER_LEVEL } from './terrain';

/**
 * The water.
 *
 * The lakes were triangles of the terrain mesh painted blue, lit as though
 * they were soil, and they looked like soil painted blue. What water needs,
 * in order:
 *
 *   1. **The sky in it** (Fresnel). Seen at a shallow angle, water is a mirror.
 *   2. **Colour with depth.** The shallows are bright and green, the middle is
 *      deep blue.
 *   3. **Waves** -- in the normal. Moving the vertices buys almost nothing.
 *   4. **Foam at the edge**, so the shoreline stops being a line.
 *
 * The shader is the source's and does the same four things. What is new is
 * where the surface comes from: the source had a grid of water tiles and could
 * read a distance-to-shore straight off it, while this world has a continuous
 * heightfield and a single water level. So the mesh is marched out of the
 * heightfield here, and the distance to shore is measured rather than
 * looked up.
 */

/** How far out from the shore counts as "deep", for the colour ramp [m]. */
const DEEP_REACH = 90;
/** The grid the water surface is built on [m]. */
const CELL = 12;

const VERT = /* glsl */ `
  attribute float aShore;
  attribute float aSea;
  varying float vShore;
  varying float vSea;
  varying vec3 vWorld;
  uniform float uTime;
  #include <fog_pars_vertex>

  void main() {
    vShore = aShore;
    vSea = aSea;
    vec3 p = position;
    // 大きなうねりだけを頂点で出す。細かい波は法線だけで足りるので、
    // ここで刻んでも三角形の数が要るばかりで見た目は良くならない。
    // 岸では振幅を 0 にして、波が陸に食い込まないようにする。
    float swell = sin(p.x * 0.035 + uTime * 0.5) * cos(p.z * 0.029 - uTime * 0.37);
    p.y += swell * 0.17 * vShore;
    vWorld = p;
    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const FRAG = /* glsl */ `
  varying float vShore;
  varying float vSea;
  varying vec3 vWorld;

  uniform float uTime;
  uniform float uNight;
  uniform float uSunIntensity;
  uniform vec3 uShallow;
  uniform vec3 uDeep;
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uSunColor;
  uniform vec3 uSunDir;
  #include <fog_pars_fragment>

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  /**
   * 波の法線。3 方向の進行波の「勾配」を足すだけ。
   * 高さそのものは要らないので、微分だけを直接書いている。
   */
  vec3 waveNormal(vec2 p, float t, float detail) {
    // うねりの位相を、ゆっくり変化するノイズでずらす。
    // 純粋な正弦波を足しただけだと必ず一定周期の畝が出て、
    // 水面ではなくコーデュロイの布に見える（実際にそうなった）。
    float warp = vnoise(p * 0.011) * 6.283;
    vec2 g = vec2(0.0);
    vec2 d1 = normalize(vec2(1.0, 0.42));
    vec2 d2 = normalize(vec2(-0.65, 1.0));
    vec2 d3 = normalize(vec2(0.3, -1.0));
    g += d1 * 0.026 * cos(dot(p, d1) * 0.19 + warp + t * 0.8);
    g += d2 * 0.019 * cos(dot(p, d2) * 0.41 - warp * 0.7 - t * 1.15);
    // 細かい波は近景でしか意味が無いので、遠くでは畳んでしまう。
    g += d3 * 0.012 * detail * cos(dot(p, d3) * 0.95 + t * 1.8);
    return normalize(vec3(-g.x, 1.0, -g.y));
  }

  void main() {
    // 遠いほど細かい波を消す。ミップマップの無い手続きノイズは
    // これをやらないと必ずモアレになる。
    float dist = length(cameraPosition - vWorld);
    float detail = 1.0 - smoothstep(120.0, 600.0, dist);
    vec3 N = waveNormal(vWorld.xz, uTime, detail);
    vec3 V = normalize(cameraPosition - vWorld);

    // フレネル。浅い角度ほど鏡になる。これが無い水は「青い床」にしかならない。
    float f = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 4.5);
    f = mix(0.035, 1.0, f);

    // 映り込む空。反射ベクトルの仰角で天頂色と地平色を混ぜる。
    // 本物の環境マップを引かなくても、空が 2 色のグラデーションである以上
    // これでほとんど同じ絵になる。
    vec3 R = reflect(-V, N);
    vec3 sky = mix(uHorizon, uZenith, clamp(R.y * 1.4, 0.0, 1.0));

    // 水そのものの色。岸辺は底が透けて明るく、沖は濃い。
    float depth = smoothstep(0.0, 0.5, vShore);
    vec3 body = mix(uShallow, uDeep, depth);

    vec3 col = mix(body, sky, f * 0.88);

    // 太陽（夜は月）の照り返し。1 点だけ強く光ると、水面が動いて見える。
    vec3 H = normalize(uSunDir + V);
    float spec = pow(max(dot(N, H), 0.0), 180.0);
    col += uSunColor * spec * uSunIntensity * 1.8;

    // 岸の泡。距離だけで出すと縁取りになるので、ノイズで食い込ませて崩す。
    //
    // 泡は**海だけ**に出す。川は幅が 1〜2 タイルしかないので、
    // 岸からの距離で出すと川床から水面まで一面が真っ白になり、
    // 遠景で川が雪の帯に見える（実際にそうなった）。
    float band = (1.0 - smoothstep(0.0, 0.17, vShore)) * vSea;
    float n = vnoise(vWorld.xz * 0.30 + vec2(uTime * 0.45, -uTime * 0.26));
    float foam = smoothstep(0.42, 0.82, band * 0.75 + n * 0.55 * band);
    col = mix(col, vec3(0.90, 0.94, 0.95), foam * 0.85);

    // 夜。真っ暗にはせず、空の映り込みだけを残す。
    col *= mix(1.0, 0.32, uNight);

    // 浅いところは底が透ける。岸辺の砂が見えると「水際」が読める。
    // 透かしすぎると汀線が霞んで、水と砂の間が一面の白い靄になる。
    float alpha = mix(0.74, 0.99, smoothstep(0.0, 0.22, vShore));
    alpha = max(alpha, foam * 0.9);

    gl_FragColor = vec4(col, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

export class WaterLayer {
  readonly group = new Object3D();
  private readonly material: ShaderMaterial;
  private mesh: Mesh | null = null;
  private readonly shallow = new Color();
  private readonly deep = new Color();

  constructor() {
    this.group.name = 'water';
    this.material = new ShaderMaterial({
      uniforms: UniformsUtils.merge([
        UniformsLib.fog,
        {
          uTime: { value: 0 },
          uNight: { value: 0 },
          uSunIntensity: { value: 1 },
          uShallow: { value: new Color(0x4d8a92) },
          uDeep: { value: new Color(0x16354f) },
          uZenith: { value: new Color(0x2a68b8) },
          uHorizon: { value: new Color(0xcadbe8) },
          uSunColor: { value: new Color(0xfff6e8) },
          uSunDir: { value: new Vector3(0, 1, 0) },
        },
      ]),
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      // 水面より下に沈んだ地形（海底）が見えるので、裏面は描かなくてよい。
      // ただし川では水面より高い岸を横から覗くことがあるので両面にする。
      side: DoubleSide,
      depthWrite: false,
      fog: true,
    });
  }

  /**
   * Build the surface from the heightfield.
   *
   * One quad per cell that is under water, with the distance to the nearest
   * dry cell carried on the vertices -- the shader wants it per fragment and
   * searching for it there would be hopeless. Corners share their value
   * between neighbouring quads, or the seams show as cracks.
   */
  build(field: Heightfield, extent: number): void {
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh = null;
    }

    const half = extent / 2;
    const size = Math.ceil(extent / CELL) + 1;
    const wet = new Uint8Array(size * size);
    const at = (ix: number, iz: number): number => iz * size + ix;
    const worldX = (ix: number): number => -half + ix * CELL;
    const worldZ = (iz: number): number => -half + iz * CELL;

    for (let iz = 0; iz < size; iz++) {
      for (let ix = 0; ix < size; ix++) {
        wet[at(ix, iz)] = field.baseHeightAt(worldX(ix), worldZ(iz)) < WATER_LEVEL ? 1 : 0;
      }
    }

    // Distance to the nearest dry sample, breadth-first from the shore. The
    // colour ramp and the foam both read it, and guessing it from the depth
    // instead looks wrong: a shallow bay and a deep one both have a shoreline.
    const shore = new Float32Array(size * size).fill(Infinity);
    const queue: number[] = [];
    for (let iz = 0; iz < size; iz++) {
      for (let ix = 0; ix < size; ix++) {
        const i = at(ix, iz);
        if (!wet[i]) continue;
        const edge = (ix > 0 && !wet[i - 1])
          || (ix < size - 1 && !wet[i + 1])
          || (iz > 0 && !wet[i - size])
          || (iz < size - 1 && !wet[i + size]);
        if (edge) {
          shore[i] = 0;
          queue.push(i);
        }
      }
    }
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head];
      const ix = i % size;
      const iz = (i / size) | 0;
      const next = shore[i] + CELL;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = ix + dx;
        const nz = iz + dz;
        if (nx < 0 || nz < 0 || nx >= size || nz >= size) continue;
        const j = at(nx, nz);
        if (!wet[j] || shore[j] <= next) continue;
        shore[j] = next;
        queue.push(j);
      }
    }

    const positions: number[] = [];
    const shores: number[] = [];
    const seas: number[] = [];
    const index: number[] = [];
    const corner = (ix: number, iz: number): number => {
      // Averaged over the four cells that meet here, so neighbouring quads
      // agree about where the shore is.
      let total = 0;
      let count = 0;
      for (const [dx, dz] of [[0, 0], [-1, 0], [0, -1], [-1, -1]] as const) {
        const x = ix + dx;
        const z = iz + dz;
        if (x < 0 || z < 0 || x >= size || z >= size) continue;
        const s = shore[at(x, z)];
        if (Number.isFinite(s)) {
          total += s;
          count++;
        }
      }
      return count === 0 ? 0 : total / count;
    };

    for (let iz = 0; iz < size - 1; iz++) {
      for (let ix = 0; ix < size - 1; ix++) {
        if (!wet[at(ix, iz)] && !wet[at(ix + 1, iz)]
          && !wet[at(ix, iz + 1)] && !wet[at(ix + 1, iz + 1)]) continue;
        const v = positions.length / 3;
        const xs = [worldX(ix), worldX(ix + 1), worldX(ix + 1), worldX(ix)];
        const zs = [worldZ(iz), worldZ(iz), worldZ(iz + 1), worldZ(iz + 1)];
        const cs: Array<[number, number]> = [
          [ix, iz], [ix + 1, iz], [ix + 1, iz + 1], [ix, iz + 1],
        ];
        for (let c = 0; c < 4; c++) {
          positions.push(xs[c], WATER_LEVEL, zs[c]);
          shores.push(Math.min(1, corner(cs[c][0], cs[c][1]) / DEEP_REACH));
          // Everything here is inland water; the source used this to tell a
          // sea from a lake, and a lake is the calmer of the two.
          seas.push(0);
        }
        index.push(v, v + 2, v + 1, v, v + 3, v + 2);
      }
    }
    if (index.length === 0) return;

    const geom = new BufferGeometry();
    geom.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    geom.setAttribute('aShore', new BufferAttribute(new Float32Array(shores), 1));
    geom.setAttribute('aSea', new BufferAttribute(new Float32Array(seas), 1));
    geom.setIndex(index);
    geom.computeBoundingSphere();
    const mesh = new Mesh(geom, this.material);
    mesh.renderOrder = 2;
    mesh.frustumCulled = true;
    // Shadows on water are stripes from the waves and nothing else.
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    this.mesh = mesh;
    this.group.add(mesh);
  }

  /** 時刻に応じて水の色と光を合わせる。毎フレーム呼ぶ（uniform を数個書くだけ）。 */
  update(atmo: Atmosphere, sunDir: Vector3, timeSec: number): void {
    const u = this.material.uniforms;
    u.uTime!.value = timeSec;
    u.uNight!.value = atmo.nightAmount;
    u.uSunIntensity!.value = atmo.sunIntensity;
    (u.uZenith!.value as Color).copy(atmo.zenith);
    (u.uHorizon!.value as Color).copy(atmo.horizon);
    (u.uSunColor!.value as Color).copy(atmo.sunColor);
    (u.uSunDir!.value as Vector3).copy(sunDir);
    // 水そのものの色も時刻で動かす。昼は緑がかった青、夕方は空の色を吸って
    // 紫に寄る。空だけが変わって水が変わらないと、途端に書き割りに見える。
    this.shallow.setHex(0x3d8288).lerp(atmo.horizon, 0.18 * (1 - atmo.nightAmount) + 0.06);
    this.deep.setHex(0x122b41).lerp(atmo.zenith, 0.2);
    (u.uShallow!.value as Color).copy(this.shallow);
    (u.uDeep!.value as Color).copy(this.deep);
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  dispose(): void {
    if (this.mesh) this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
