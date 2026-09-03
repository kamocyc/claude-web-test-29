import type { Vector3 } from 'three';
import type { WorldWarning } from '../render/worldBuilder';

/**
 * 警告一覧のまとめかた。
 *
 * 移植元 (TrackBuilder) では lil-gui のパネル (`app/ui.ts`) の中にあったが、
 * この街では警告の見せ方は既存の警告ウィンドウが持っている。パネルは持ってこず、
 * 「同じ内容をまとめて、押すたびに次の場所へ送る」という中身だけを移した。
 */
export interface WarningGroup {
  message: string;
  severity: WorldWarning['severity'];
  /** その警告が出ている場所。行を押すたびに次へ進む。 */
  places: Vector3[];
  /** 次に見る場所の番号。 */
  next: number;
}

/**
 * 同じ内容の警告を 1 行にまとめる。
 *
 * 場所は捨てずに全部持っておく。同じ文言が何十か所にも出ることがあり、
 * 「どこの話なのか」は行を押して 1 か所ずつ見て回れるようにするため。
 * 出た順を保つので、一覧の並びは作り直しても変わらない。
 */
export function groupWarnings(warnings: readonly WorldWarning[]): WarningGroup[] {
  const groups = new Map<string, WarningGroup>();
  for (const warning of warnings) {
    let group = groups.get(warning.message);
    if (!group) {
      group = { message: warning.message, severity: warning.severity, places: [], next: 0 };
      groups.set(warning.message, group);
    }
    if (warning.position) group.places.push(warning.position.clone());
    // 同じ文言で重さが混ざったら、重い方の色で出す。
    if (warning.severity === 'error') group.severity = 'error';
  }
  return [...groups.values()];
}

/** その警告の次の場所 (押すたびに 1 か所ずつ進み、最後まで行くと戻る)。 */
export function nextPlace(group: WarningGroup): Vector3 | null {
  if (group.places.length === 0) return null;
  const place = group.places[group.next % group.places.length];
  group.next = (group.next + 1) % group.places.length;
  return place;
}
