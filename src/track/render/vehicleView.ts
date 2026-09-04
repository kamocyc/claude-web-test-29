import {
  AdditiveBlending,
  Color,
  Group,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
  type BufferGeometry,
} from 'three';
import { agentSurface, type AgentSurface } from '../../look/agentMaterial';
import { InstancePool } from '../../look/instancePool';
import type { Atmosphere } from '../../look/sky';
import {
  beamGeometry,
  carBeamSpec,
  carGeometry,
  carIdleBeamSpec,
  carKind,
  carLampGeometry,
  carLength,
  carPaint,
  trainBeamSpec,
  trainGeometry,
  trainLampGeometry,
  CAR_KIND_COUNT,
  type CarKind,
  type TrainFace,
} from '../../look/vehicleParts';
import type { Vehicle } from '../sim/traffic';
import { bodyQuaternion } from './vehicles';

/**
 * 走っているものの描画 (移植先で足した: 移植元 claude-web-test-21 の造形)。
 *
 * これまでは 1 両につき箱 3 つだった。実寸なので縮尺は正しいのだが、路上に
 * 降りると「色の付いた直方体が流れている」だけで、軽自動車もセダンも形からは
 * 区別が付かない。移植元の造形は、ボンネット・キャビン・トランクの段差、
 * 前後に絞った腰、8 角柱のタイヤまで持っていて、車が車に見える。
 *
 * 描き方は 3 つの決めごとで成り立っている。
 *
 * 1. **1 形状 = 1 InstancedMesh。** 車種 5 + 電車 3 面で 8 つ。街に何台
 *    走ろうとドローコールは 8 のまま増えない。
 * 2. **頂点色は変調係数**として持たせる (車体を白、窓を暗い灰、タイヤを
 *    ほぼ黒)。`instanceColor` に車体色を入れるだけで「白い車の窓は明るい灰、
 *    黒い車の窓は真っ黒」が自然に付いてくる。
 * 3. **ガラスだけは変調から外す** (`aGlass` 属性)。掛け算のままだと、黒い車の
 *    窓が RGB ほぼ 0 に潰れて、昼の路上でも上半分が真っ黒な天蓋になる。
 *    ガラスは空を映すものなので、明るさは反射の側から作る。
 *
 * 夜は前照灯と尾灯が点き、路面に光の板が伸びる。走っている車と停まっている
 * 車で板の長さを変えてあるのは、同じ長さだと路肩の車の光が繋がって
 * **一本の光の帯**になるため。
 */

/** この距離より遠い車両は描かない [m]。 */
const REACH = 520;
/** 光の板を出す距離 [m]。灯りは車体より早く読めなくなる。 */
const LAMP_REACH = 300;

type ShapeKey = string;

const carShape = (kind: CarKind): ShapeKey => `car${kind}`;
const trainShape = (face: TrainFace): ShapeKey => `train${face}`;

interface Shape {
  body: InstancePool;
  lamp: InstancePool;
  beam: InstancePool;
  /** 車体の長さ [m]。走行の当たり判定より長い形は縮める。 */
  length: number;
  /** 光の板の置き方。 */
  beamSpec: { z: number; width: number; length: number; y: number };
  idleBeamSpec?: { z: number; width: number; length: number; y: number };
}

export class VehicleView {
  readonly group = new Group();
  private readonly shapes = new Map<ShapeKey, Shape>();
  private readonly surface: AgentSurface;
  private readonly lampMaterial: MeshBasicMaterial;
  private readonly beamMaterial: MeshBasicMaterial;

  private readonly matrix = new Matrix4();
  private readonly quaternion = new Quaternion();
  private readonly position = new Vector3();
  private readonly scale = new Vector3(1, 1, 1);
  private readonly tint = new Color();
  private readonly forward = new Vector3();

  constructor() {
    this.group.name = 'vehicles';
    // ガラスを持つ造形なので `glass: true`。夜の持ち上げは車のほうを強くする
    // (人より車のほうが、真っ黒になったときに何か分からなくなる)。
    this.surface = agentSurface({ roughness: 0.42, metalness: 0.22, glass: true });
    this.lampMaterial = new MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      toneMapped: false,
    });
    this.beamMaterial = new MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0,
      blending: AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });

    for (let kind = 0; kind < CAR_KIND_COUNT; kind++) {
      this.addShape(
        carShape(kind as CarKind),
        carGeometry(kind as CarKind),
        carLampGeometry(kind as CarKind),
        carLength(kind as CarKind),
        carBeamSpec(kind as CarKind),
        carIdleBeamSpec(kind as CarKind),
      );
    }
    for (const face of [1, 0, -1] as const) {
      this.addShape(
        trainShape(face),
        trainGeometry(face),
        trainLampGeometry(face),
        19,
        trainBeamSpec(),
      );
    }
  }

  private addShape(
    key: ShapeKey,
    body: BufferGeometry,
    lamp: BufferGeometry,
    length: number,
    beamSpec: Shape['beamSpec'],
    idleBeamSpec?: Shape['beamSpec'],
  ): void {
    const shape: Shape = {
      body: new InstancePool(body, this.surface.material, this.group, true, 128),
      lamp: new InstancePool(lamp, this.lampMaterial, this.group, true, 128),
      beam: new InstancePool(beamGeometry(), this.beamMaterial, this.group, true, 128),
      length,
      beamSpec,
      idleBeamSpec,
    };
    shape.body.setShadows(true, false);
    // 光の板は最後に。加算合成なので、路面より先に描くと下に潜る。
    shape.beam.setRenderOrder(3);
    shape.lamp.setRenderOrder(4);
    this.shapes.set(key, shape);
  }

  /** 時刻を渡す。夜の灯りと、ガラスが映す空がここで決まる。 */
  setAtmosphere(atmo: Atmosphere): void {
    this.surface.night.value = atmo.nightAmount;
    this.surface.glassSky.value.copy(atmo.zenith);
    this.surface.glassHorizon.value.copy(atmo.horizon);
    this.surface.glassGround.value.copy(atmo.horizon).multiplyScalar(0.4);
    // 灯りは日が落ちきる前から点く。実際にそうだし、点灯が一斉だと
    // 「スイッチが入った」ように見える。
    const on = Math.max(0, Math.min(1, (atmo.nightAmount - 0.1) / 0.45));
    this.lampMaterial.opacity = on;
    this.beamMaterial.opacity = on * 0.75;
  }

  /**
   * シミュレーションの状態を写す。
   *
   * `highlight` に番号を渡すと、その車両だけ選択色で塗る (乗る車両を
   * 選んでいるとき)。車体色は配置ごとにばらばらなので、輪郭ではなく
   * 塗り替えで示す。
   */
  sync(vehicles: readonly Vehicle[], highlight: number | null = null, eye?: Vector3): void {
    for (const shape of this.shapes.values()) {
      shape.body.begin();
      shape.lamp.begin();
      shape.beam.begin();
    }

    const lit = this.lampMaterial.opacity > 0.01;
    for (const vehicle of vehicles) {
      const train = vehicle.kind === 'train';
      const kind = train ? 0 : carKind(vehicle.id);
      const paint = vehicle.id === highlight
        ? MARKED
        : train
          ? null
          : carPaint(vehicle.id);

      vehicle.bodies.forEach((pose, index) => {
        if (eye && Math.hypot(pose.pos.x - eye.x, pose.pos.z - eye.z) > REACH) return;

        const key = train
          ? trainShape(faceOf(index, vehicle.cars))
          : carShape(kind as CarKind);
        const shape = this.shapes.get(key);
        if (!shape) return;

        // 当たり判定より長い形は縮める。伸ばしはしない -- 軽自動車が
        // セダンの枠いっぱいに伸びると、形を作り分けた意味が無くなる。
        const fit = Math.min(1, vehicle.size.length / shape.length);
        this.scale.setScalar(fit);
        this.position.copy(pose.pos);
        bodyQuaternion(pose.dir, pose.roll, this.quaternion);
        this.matrix.compose(this.position, this.quaternion, this.scale);

        // 電車は路線の色。車は移植元の塗色表から引く (シミュレーション側の
        // 色は「区別が付けばよい」乱数で、日本の路上の配色ではない)。
        if (paint === null) this.tint.setRGB(vehicle.color[0], vehicle.color[1], vehicle.color[2]);
        else this.tint.setHex(paint);
        shape.body.push(this.matrix, this.tint);

        if (!lit) return;
        if (eye && Math.hypot(pose.pos.x - eye.x, pose.pos.z - eye.z) > LAMP_REACH) return;
        shape.lamp.push(this.matrix, WHITE);

        // 光の板は先頭だけ。中間車から光が伸びると、編成が「光の梯子」になる。
        if (index > 0) return;
        const moving = vehicle.speed > 1.2;
        const spec = moving ? shape.beamSpec : (shape.idleBeamSpec ?? shape.beamSpec);
        this.forward.set(0, 0, 1).applyQuaternion(this.quaternion);
        this.position
          .copy(pose.pos)
          .addScaledVector(this.forward, spec.z * fit);
        this.position.y += spec.y;
        this.scale.set(spec.width * fit, 1, spec.length * fit);
        this.matrix.compose(this.position, this.quaternion, this.scale);
        shape.beam.push(this.matrix, moving ? WHITE : DIM);
      });
    }

    for (const shape of this.shapes.values()) {
      shape.body.end();
      shape.lamp.end();
      shape.beam.end();
    }
  }

  /** 車両を隠す (シミュレーションを止めたとき)。 */
  clear(): void {
    for (const shape of this.shapes.values()) {
      shape.body.begin();
      shape.body.end();
      shape.lamp.begin();
      shape.lamp.end();
      shape.beam.begin();
      shape.beam.end();
    }
  }

  dispose(): void {
    for (const shape of this.shapes.values()) {
      shape.body.dispose();
      shape.lamp.dispose();
      shape.beam.dispose();
    }
    this.shapes.clear();
    this.surface.material.dispose();
    this.lampMaterial.dispose();
    this.beamMaterial.dispose();
  }
}

/** 編成のどの位置かで、先頭・中間・最後尾の顔を選ぶ。 */
function faceOf(index: number, cars: number): TrainFace {
  if (index === 0) return 1;
  if (index === cars - 1) return -1;
  return 0;
}

const WHITE = new Color(1, 1, 1);
/** 停まっている車の光の板。走行中より落とす。 */
const DIM = new Color(0.5, 0.5, 0.5);
/**
 * 乗る車両を選んでいるときに、指している車両を塗る色。
 *
 * 遠くから見下ろしていると車両は数ピクセルしかないので、目立つ色にする。
 */
const MARKED = 0xffd34a;
