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

/** The controls for one ordinance, built once and afterwards only updated. */
interface OrdinanceRow {
  root: HTMLElement;
  box: HTMLInputElement;
  cost: HTMLElement;
}

/**
 * The city's by-laws: five switches, what each one does, and what it costs.
 *
 * The switches are built **once** and afterwards only have their values set,
 * unlike every read-only panel in the game, which throws its body away and
 * builds it again from the simulation. That pattern is right for a number and
 * wrong for a control: a checkbox replaced between the player's mouse-down and
 * their mouse-up is a click the browser never delivers, because it only fires
 * one when both landed on the same element -- which is the same trap
 * `HelpState` exists for on the "？" buttons. Only the bill below them is
 * rebuilt, and nothing in it is clickable.
 *
 * The cost column deliberately shows what each ordinance *would* cost today
 * rather than only what was billed last night: one switched on this morning
 * has never been billed, so a panel that only reported history would answer
 * "—" to the question the player is asking before they flip the switch.
 */
export class PoliciesPanel {
  private readonly body: HTMLElement;
  private readonly rows = new Map<Ordinance, OrdinanceRow>();
  private readonly bill: HTMLElement;
  private lastDraw = 0;

  constructor(root: HTMLElement, private readonly cb: PoliciesCallbacks) {
    root.innerHTML = '';
    this.body = document.createElement('div');
    this.body.className = 'policies-body';

    for (const ordinance of ALL_ORDINANCES) {
      const built = this.buildRow(ordinance);
      this.rows.set(ordinance, built);
      this.body.appendChild(built.root);
    }

    this.bill = document.createElement('div');
    this.body.appendChild(this.bill);
    root.append(this.body);
  }

  update(sim: Simulation, now = performance.now()): void {
    if (now - this.lastDraw < REFRESH_MS) return;
    this.lastDraw = now;

    const { policies } = sim;
    for (const [ordinance, el] of this.rows) {
      const on = policies.isOn(ordinance);
      el.root.classList.toggle('on', on);
      el.box.checked = on;
      // Priced on yesterday's traffic, so every row in this column is a day.
      el.cost.textContent = `${
        formatMoney(policies.costOf(ordinance, sim.world, sim.ridersLastDay))}/日`;
    }

    // Last night's bill is read from the bill rather than from what is
    // switched on now: an ordinance repealed this morning was still paid for
    // yesterday, and one passed this morning was not.
    this.bill.innerHTML = '';
    this.bill.appendChild(section('前日の請求', [
      ...ALL_ORDINANCES
        .filter((o) => policies.lastBill.has(o))
        .map((o) => row(`　${ORDINANCES[o].name}`, formatMoney(policies.lastBill.get(o) ?? 0))),
      row('合計', formatMoney(sim.economy.breakdown.ordinances),
        sim.economy.breakdown.ordinances > 0),
      ...(policies.enabled.length === 0 ? [note('施行中の条例はありません。')] : []),
    ]));
  }

  private buildRow(ordinance: Ordinance): OrdinanceRow {
    const spec = ORDINANCES[ordinance];

    const root = document.createElement('div');
    root.className = 'policy';

    const head = document.createElement('label');
    head.className = 'policy-head';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.addEventListener('change', () => this.cb.onToggle(ordinance));
    const name = document.createElement('span');
    name.className = 'policy-name';
    name.textContent = spec.name;
    const cost = document.createElement('span');
    cost.className = 'policy-cost';
    head.append(box, name, cost);

    const effect = document.createElement('p');
    effect.className = 'stat-note';
    effect.textContent = `${spec.effect}（費用: ${spec.billing}）`;

    root.append(head, effect);
    return { root, box, cost };
  }
}
