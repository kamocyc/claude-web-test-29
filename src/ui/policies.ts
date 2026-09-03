import { ALL_ORDINANCES, ORDINANCES, type Ordinance } from '../sim/policies';
import type { Simulation } from '../sim/simulation';
import { formatMoney } from './money';
import { note, row, section } from './widgets';

/** Shown by the window's "？". */
export const POLICIES_HELP = '条例は「いま動いている仕組みの数字を1つ動かす」ものだけです。'
  + '効果はそれぞれの担当ウィンドウ（電力・公共・統計）にそのまま出ます。'
  + '費用は毎日の支出で、街の規模に比例します — 乗車人数・建物数・人口・公園の数。'
  + '建設費と違って残高が足りなくても止まらないので、赤字のまま放置すると利息がつきます。';

const REFRESH_MS = 250;

export interface PoliciesCallbacks {
  onToggle(ordinance: Ordinance): void;
}

/**
 * The city's by-laws: five switches, what each one does, and what it costs.
 *
 * Deliberately shows the *estimated cost today* rather than only what was
 * billed last night. An ordinance that was switched on this morning has never
 * been billed, so a panel that only reported history would answer "—" to the
 * one question the player is asking before they flip the switch.
 */
export class PoliciesPanel {
  private readonly body: HTMLElement;
  private lastDraw = 0;
  private dirty = true;

  constructor(root: HTMLElement, private readonly cb: PoliciesCallbacks) {
    root.innerHTML = '';
    this.body = document.createElement('div');
    this.body.className = 'policies-body';
    root.append(this.body);
  }

  update(sim: Simulation, now = performance.now()): void {
    if (!this.dirty && now - this.lastDraw < REFRESH_MS) return;
    this.lastDraw = now;
    this.dirty = false;

    const { policies } = sim;
    const riders = ridersYesterday(sim);

    this.body.innerHTML = '';
    this.body.append(
      ...ALL_ORDINANCES.map((o) => this.ordinanceRow(sim, o, riders)),
      section('前日の請求', [
        ...ALL_ORDINANCES
          .filter((o) => policies.isOn(o))
          .map((o) => row(
            `　${ORDINANCES[o].name}`,
            formatMoney(policies.lastBill.get(o) ?? 0),
          )),
        row('合計', formatMoney(sim.economy.breakdown.ordinances),
          sim.economy.breakdown.ordinances > 0),
        policies.enabled.length === 0 ? note('施行中の条例はありません。') : note(''),
      ]),
    );
  }

  private ordinanceRow(sim: Simulation, ordinance: Ordinance, riders: number): HTMLElement {
    const spec = ORDINANCES[ordinance];
    const on = sim.policies.isOn(ordinance);

    const wrap = document.createElement('div');
    wrap.className = on ? 'policy on' : 'policy';

    const head = document.createElement('label');
    head.className = 'policy-head';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = on;
    box.addEventListener('change', () => {
      this.dirty = true;
      this.cb.onToggle(ordinance);
    });
    const name = document.createElement('span');
    name.className = 'policy-name';
    name.textContent = spec.name;
    const cost = document.createElement('span');
    cost.className = 'policy-cost';
    cost.textContent = `${formatMoney(sim.policies.costOf(ordinance, sim.world, riders))}/日`;
    head.append(box, name, cost);

    const effect = document.createElement('p');
    effect.className = 'stat-note';
    effect.textContent = `${spec.effect}（費用: ${spec.billing}）`;

    wrap.append(head, effect);
    return wrap;
  }
}

/**
 * Rides carried since the books last closed -- the figure the fare subsidy is
 * billed on, read from the same counter the billing reads.
 */
function ridersYesterday(sim: Simulation): number {
  let total = 0;
  for (const line of sim.world.lines) total += line.ridership;
  return Math.max(0, total - sim.ridershipAtDayStart);
}
