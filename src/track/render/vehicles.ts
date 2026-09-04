import { Matrix4, Quaternion, Vector3 } from 'three';
import type { VehicleKind } from '../sim/lanegraph';

/**
 * 車体の寸法と姿勢。
 *
 * 描画そのものは `vehicleView.ts` が移植した造形で行う。ここに残して
 * あるのは、**描画以外からも要る** 2 つ -- 一人称視点の目の高さを決める
 * 比率と、進行方向と横断勾配から車体の姿勢を作る計算。どちらも
 * 描画を差し替えても変わらない。
 */

/**
 * 車体の箱の比率 (車高に対する割合)。
 *
 * 一人称視点の目の高さもここから決めるので、外から読めるようにしておく。
 * 目が屋根より上に出ると、自分の車の屋根を見下ろすことになる (箱の外側の
 * 面を上から見る形になり、視界の下半分が車体色で埋まる)。
 */
export const BODY_SHAPE = {
  /** 足回り (路面に接する暗い箱) の上端。 */
  skirt: 0.18,
  /** 車体の高さ。足回りの上端から積む。 */
  shell: { car: 0.5, train: 0.62 } as Record<VehicleKind, number>,
} as const;

/** 車体 (屋根) の上端。車高に対する割合。 */
export function roofOf(kind: VehicleKind): number {
  return BODY_SHAPE.skirt + BODY_SHAPE.shell[kind];
}

const FORWARD = new Vector3(0, 0, 1);
const UP = new Vector3(0, 1, 0);
/** 姿勢を組み立てるための使い回しの行列と四元数。 */
const BASIS = new Matrix4();
const ROLL = new Quaternion();

/**
 * 進行方向と路面の横断勾配から車体の姿勢を作る。勾配のある所では前後に、
 * カント (踏切の傾き) のある所では左右に傾く。
 *
 * 「+Z から進行方向への最短回転」で作ってはいけない。ほぼ -Z へ進むとき
 * (向きが真後ろ) は回転軸が定まらず、勾配のわずかな上下成分だけで軸が X 側
 * へ倒れて、車体が**上下反転**することがある。上向きを固定した基底から
 * 作れば、どの向き・どの勾配でも屋根が上を向く。
 *
 * 横断勾配は、その基底を進行方向まわりに回して与える。右が高い (正) なら
 * 右へ傾く。傾きは勾配 (右へ 1 m あたりの上がり) なので、角度は `atan`。
 */
export function bodyQuaternion(
  dir: Vector3,
  roll = 0,
  target = new Quaternion(),
): Quaternion {
  const forward = dir.lengthSq() < 1e-8 ? FORWARD.clone() : dir.clone().normalize();
  const right = new Vector3().crossVectors(UP, forward);
  if (right.lengthSq() < 1e-10) {
    // 真上・真下を向いている (ふつうの勾配では起きない)。
    right.crossVectors(FORWARD, forward);
    if (right.lengthSq() < 1e-10) right.set(1, 0, 0);
  }
  right.normalize();
  const up = new Vector3().crossVectors(forward, right).normalize();
  target.setFromRotationMatrix(BASIS.makeBasis(right, up, forward));
  if (roll !== 0) target.multiply(ROLL.setFromAxisAngle(FORWARD, Math.atan(roll)));
  return target;
}
