import {
  ACESFilmicToneMapping,
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  Mesh,
  PerspectiveCamera,
  PCFSoftShadowMap,
  PMREMGenerator,
  Raycaster,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Texture,
  type WebGLRenderTarget,
} from 'three';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';
import { VIEW_DISTANCE } from '../core/units';
import { atmosphereAt, SkyDome, sunDirection, type Atmosphere } from '../../look/sky';
import { PostFx } from '../../look/postfx';

/**
 * 一人称視点のときの近クリップ面 [m]。
 *
 * 俯瞰の 1 m のままだと、目の前の路面や車体が切り取られる。近づけすぎると
 * 遠くで奥行きの精度が落ちるので、目の高さ (1.1〜2.4 m) に対して十分近い所で
 * 止める。
 */
const RIDE_NEAR = 0.4;

/**
 * 3D 表示まわり。レンダラ・カメラ・光源・空と、地形へのレイキャストを持つ。
 */
export class Viewport {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly controls: MapControls;
  private readonly sun: DirectionalLight;
  /** 空からの回り込みと地面からの照り返し。時刻で色が変わる。 */
  private readonly hemi: HemisphereLight;
  /** 空のドーム。視点を包んだままにするので、いつも同じ空が見える。 */
  readonly sky = new SkyDome(VIEW_DISTANCE * 1.5);
  /** 仕上げの一段。重い環境では自分で降りる。 */
  readonly fx: PostFx;
  /** いまの大気。時刻から連続で作る。 */
  readonly atmosphere: Atmosphere = atmosphereAt(0.5);
  /** Where the sun is now. The water reflects it, so it is not private. */
  readonly sunDirection = new Vector3(0, 1, 0);
  private elapsed = 0;
  private lastFrameAt = performance.now();
  /**
   * The sky, baked into an environment map.
   *
   * Not a nicety. Every standard material in the scene takes a good part of
   * its ambient from `scene.environment`, and with nothing there glass and
   * metal have nothing to reflect and walls light only from the sun and the
   * hemisphere -- which is why the buildings came out of the port looking
   * like dark cardboard while the ground beside them looked fine.
   *
   * Baking is not cheap, so it is redone only when the time of day has moved
   * enough to matter.
   */
  private readonly pmrem: PMREMGenerator;
  private readonly skyScene = new Scene();
  private envTarget: WebGLRenderTarget | null = null;
  private envAt = -1;
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  /** 一人称視点に入る前の視点。降りたときに戻す。 */
  private savedView: { position: Vector3; target: Vector3; near: number } | null = null;
  /** 進行中の注視点移動 (`panTo`)。 */
  private flight: { from: Vector3; to: Vector3; start: number; duration: number } | null = null;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.98;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;

    // 遠景は地平の色に溶かす。空とフォグと環境光が同じ 1 組の値から来る
    // ので、時刻が変わっても three つが食い違わない。
    this.scene.fog = new Fog(0xcadbe8, VIEW_DISTANCE * 0.45, VIEW_DISTANCE * 1.35);
    this.scene.background = new Color(0x9fc4e0);
    this.camera = new PerspectiveCamera(52, 1, 1, VIEW_DISTANCE * 1.6);
    this.camera.position.set(150, 180, 220);

    this.controls = new MapControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.minDistance = 20;
    // 引ける上限は見通す距離まで。マップに比例させると、広いマップでは
    // 何も見えない高さまで引けてしまう。
    this.controls.maxDistance = VIEW_DISTANCE * 0.75;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.target.set(0, 0, 0);

    this.hemi = new HemisphereLight(0xbcd0e6, 0x6f6a58, 0.85);
    this.scene.add(this.hemi);

    this.sun = new DirectionalLight(0xfff2df, 1.55);
    this.sun.position.set(-160, 240, 120);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const shadowExtent = 260;
    this.sun.shadow.camera.left = -shadowExtent;
    this.sun.shadow.camera.right = shadowExtent;
    this.sun.shadow.camera.top = shadowExtent;
    this.sun.shadow.camera.bottom = -shadowExtent;
    this.sun.shadow.camera.near = 10;
    this.sun.shadow.camera.far = 900;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.6;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.scene.add(this.sky.mesh);
    // A second dome sharing the same material, in a scene of its own, is what
    // the environment map is baked from.
    this.skyScene.add(this.sky.clone(10));
    this.pmrem = new PMREMGenerator(this.renderer);
    this.pmrem.compileEquirectangularShader();
    this.fx = new PostFx(this.renderer, this.scene, this.camera);

    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.setTimeOfDay(0.5);
  }

  /**
   * Put the world at a time of day (0 = midnight, 0.5 = noon).
   *
   * One call sets the sky, the sun, the ambient, the fog and the exposure,
   * because they all come out of the same atmosphere. Setting them
   * separately is how a scene ends up with a sunset sky over midday
   * lighting -- which reads as a bug even when nobody can say why.
   */
  setTimeOfDay(dayFraction: number): void {
    const atmo = atmosphereAt(dayFraction, this.atmosphere);
    sunDirection(dayFraction, this.sunDirection);

    this.sun.color.copy(atmo.sunColor);
    this.sun.intensity = atmo.sunIntensity;
    this.hemi.color.copy(atmo.skyLight);
    this.hemi.groundColor.copy(atmo.groundLight);
    this.hemi.intensity = atmo.ambientIntensity;
    this.renderer.toneMappingExposure = atmo.exposure;
    (this.scene.fog as Fog).color.copy(atmo.horizon);
    (this.scene.background as Color).copy(atmo.horizon);
    // A small lean in the grade, the way the light already leans: warm in the
    // late afternoon, cool at dawn and through the night. (The first attempt
    // had this inverted -- a cool noon and a warm midnight -- which made the
    // whole day read wrong without it being obvious why.)
    const hour = dayFraction * 24;
    const warmth = hour > 15 && hour < 20
      ? 0.9
      : hour > 5 && hour < 8
        ? -0.55
        : hour < 5 || hour >= 20
          ? -0.7
          : 0.1;
    this.fx.setMood(atmo.nightAmount, warmth);
    this.updateEnvironment(dayFraction);
  }

  /** Re-bake the sky's reflection, when the sky has moved enough to show. */
  private updateEnvironment(dayFraction: number): void {
    if (this.envAt >= 0 && Math.abs(dayFraction - this.envAt) < 0.006) return;
    this.envAt = dayFraction;
    // The dome reads its uniforms at bake time, so it has to be told the
    // atmosphere before the bake, not after it.
    this.sky.update(this.atmosphere, this.sunDirection, { x: 0, y: 0, z: 0 }, this.elapsed);
    const previous = this.envTarget;
    this.envTarget = this.pmrem.fromScene(this.skyScene, 0, 0.1, 100);
    this.scene.environment = this.envTarget.texture as Texture;
    this.scene.environmentIntensity = 1;
    previous?.dispose();
  }

  /** How dark it is now, 0..1. Anything that lights up at night reads this. */
  get nightAmount(): number {
    return this.atmosphere.nightAmount;
  }

  resize(): void {
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.fx?.setSize(width * this.renderer.getPixelRatio(), height * this.renderer.getPixelRatio());
  }

  /** 影のカメラを注視点に追従させ、広いマップでも影の解像度を保つ。 */
  private updateShadowCamera(): void {
    const t = this.controls.target;
    // 光の向きは時刻から来る。影が朝は長く西へ、夕は長く東へ伸びる。
    this.sun.position.set(
      t.x + this.sunDirection.x * 320,
      t.y + Math.max(40, this.sunDirection.y * 320),
      t.z + this.sunDirection.z * 320,
    );
    this.sun.target.position.copy(t);
    this.sun.target.updateMatrixWorld();
  }

  /**
   * 一人称視点に入る。いまの視点を控え、地図操作を止める。
   *
   * `MapControls` は `update()` のたびに注視点と球面座標からカメラを置き直す
   * ので、止めずに位置を書き込んでも次のフレームで戻されてしまう。
   */
  beginRide(): void {
    if (this.savedView) return;
    this.savedView = {
      position: this.camera.position.clone(),
      target: this.controls.target.clone(),
      near: this.camera.near,
    };
    this.controls.enabled = false;
    this.camera.near = RIDE_NEAR;
    this.camera.updateProjectionMatrix();
  }

  /** 一人称視点をやめ、入る前の視点に戻す。 */
  endRide(): void {
    const saved = this.savedView;
    if (!saved) return;
    this.savedView = null;
    this.camera.position.copy(saved.position);
    this.controls.target.copy(saved.target);
    this.camera.near = saved.near;
    this.camera.up.set(0, 1, 0);
    this.camera.updateProjectionMatrix();
    this.controls.enabled = true;
    this.controls.update();
  }

  /**
   * 一人称視点のカメラを、目の位置・向き・頭の上の向きから置く。
   *
   * `up` を渡すのはカントのため。鉛直に固定すると、車体だけが傾いて
   * 窓の外は水平のまま、という見え方になる。
   */
  placeEye(eye: Vector3, forward: Vector3, up: Vector3): void {
    this.camera.position.copy(eye);
    this.camera.up.copy(up);
    this.camera.lookAt(eye.x + forward.x, eye.y + forward.y, eye.z + forward.z);
    // 影のカメラは注視点に追従するので、見ている先を渡しておく。
    this.controls.target.copy(eye).addScaledVector(forward, 40);
  }

  /** 注視点から視点までの距離 [m]。 */
  get viewDistance(): number {
    return this.camera.position.distanceTo(this.controls.target);
  }

  /**
   * 画面に対して平行移動する (注視点と視点を同じだけ動かす)。
   *
   * `forward` は画面の奥へ、`right` は画面の右へ進む距離 [m]。向きは
   * カメラの視線を水平面に落として決めるので、俯角や方位を変えても
   * 「W で画面の奥、D で画面の右」が変わらない。
   *
   * `MapControls.update()` は注視点からの相対位置でカメラを置き直すので、
   * 両方を同じだけ動かせば向きも距離もそのまま残る。
   */
  panScreen(forward: number, right: number): void {
    if (forward === 0 && right === 0) return;
    // 視線を水平面へ落とす。真下を向いていると長さが 0 になるので、
    // そのときは画面の上向き (カメラの向き) を代わりに使う。
    const ahead = new Vector3().subVectors(this.controls.target, this.camera.position);
    ahead.y = 0;
    if (ahead.lengthSq() < 1e-6) {
      ahead.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
      ahead.y = 0;
    }
    const delta = screenPanDelta(ahead, forward, right);
    this.controls.target.add(delta);
    this.camera.position.add(delta);
  }

  /**
   * 注視点を `to` へ滑らかに移す (向きも距離もそのまま)。
   *
   * 警告の一覧から飛ぶときに使う。瞬間移動させると、どこから来て
   * どこへ行ったのかが分からなくなるので、短い時間で滑らせる。
   */
  panTo(to: Vector3, seconds = 0.5): void {
    this.flight = {
      from: this.controls.target.clone(),
      to: to.clone(),
      start: performance.now(),
      duration: Math.max(1, seconds * 1000),
    };
  }

  /** 進行中の注視点移動をやめる (利用者が視点を触ったとき)。 */
  cancelPan(): void {
    this.flight = null;
  }

  private updateFlight(): void {
    const flight = this.flight;
    if (!flight) return;
    const t = Math.min(1, (performance.now() - flight.start) / flight.duration);
    // 出入りを滑らかにする (smoothstep)。
    const eased = t * t * (3 - 2 * t);
    const next = flight.from.clone().lerp(flight.to, eased);
    const delta = next.sub(this.controls.target);
    this.controls.target.add(delta);
    this.camera.position.add(delta);
    if (t >= 1) this.flight = null;
  }

  render(): void {
    // 一人称視点の間は、カメラを外から置いている。
    if (this.controls.enabled) {
      this.updateFlight();
      this.controls.update();
    }
    // 空は視点に付いて回る。置いたままにすると、引いたときにドームの縁が
    // 空の中に見えてしまう。
    this.elapsed = performance.now() / 1000;
    this.sky.update(this.atmosphere, this.sunDirection, this.camera.position, this.elapsed);
    this.updateShadowCamera();
    this.fx.setAoScale(this.viewDistance);
    const now = performance.now();
    this.fx.render(this.scene, this.camera, now - this.lastFrameAt);
    this.lastFrameAt = now;
  }



  /** 画面座標 (CSS ピクセル) を正規化デバイス座標に変換して保持する。 */
  setPointer(clientX: number, clientY: number): void {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  /**
   * 現在のポインタ位置から伸びるレイ (ワールド座標)。
   *
   * 地形や路面ではなく**車両**を指すのに使う。車両は毎フレーム動くので
   * シーングラフに問い合わせず、姿勢から直に当たり判定する (`hitBody`)。
   */
  ray(): { origin: Vector3; direction: Vector3 } {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return {
      origin: this.raycaster.ray.origin.clone(),
      direction: this.raycaster.ray.direction.clone(),
    };
  }

  /** 現在のポインタ位置から対象メッシュへレイキャストする。 */
  pick(targets: Mesh[]): Vector3 | null {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(targets, false);
    return hits.length > 0 ? hits[0].point.clone() : null;
  }
}

/**
 * 画面に対する平行移動量。
 *
 * `ahead` は視線の水平成分 (長さは問わない)、`forward` は画面の奥へ、
 * `right` は画面の右へ進む距離 [m]。
 *
 * Y 上・右手系では、水平な視線 `(x, 0, z)` の右手は `(視線 × 上)` =
 * `(-z, 0, x)`。真上から見下ろす画面では、視線が -Z のとき右が +X に
 * なる (地図を北向きに見ているときの東)。
 */
export function screenPanDelta(ahead: Vector3, forward: number, right: number): Vector3 {
  const dir = ahead.clone();
  dir.y = 0;
  if (dir.lengthSq() < 1e-12) dir.set(0, 0, -1);
  dir.normalize();
  const side = new Vector3(-dir.z, 0, dir.x);
  return dir.multiplyScalar(forward).addScaledVector(side, right);
}

/** 天頂から地平にかけて色が変わる簡単な空。視点を中心に置いて使う。 */
