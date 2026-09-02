import { LOAN_TRANCHE, TAX_RATE_LIMITS } from '../config';
import type { Simulation } from '../sim/simulation';
import type { TaxRates } from '../sim/economy';
import { formatMoney, formatPercent } from './money';

const REFRESH_MS = 250;

export interface BudgetCallbacks {
  onRate(category: keyof TaxRates, delta: number): void;
  onBorrow(): void;
  onRepay(): void;
}

const CATEGORIES: ReadonlyArray<[keyof TaxRates, string]> = [
  ['residential', '住宅税'],
  ['commercial', '商業税'],
  ['industrial', '工業税'],
  ['office', 'オフィス税'],
];

/**
 * The city's finances: what came in, what went out, and the two levers the
 * player has over it.
 *
 * The daily figures are last night's actual books rather than a projection.
 * A projection would have to guess at how much the shops will sell tomorrow,
 * and would then disagree with the balance when they sell less -- which is
 * exactly the situation the panel exists to make legible.
 */
export class BudgetPanel {
  private readonly body: HTMLElement;
  private lastDraw = 0;

  constructor(root: HTMLElement, private readonly cb: BudgetCallbacks) {
    root.innerHTML = '';
    const title = document.createElement('h2');
    title.textContent = '財政';
    this.body = document.createElement('div');
    this.body.className = 'budget-body';
    root.append(title, this.body);
  }

  update(sim: Simulation, now = performance.now()): void {
    if (now - this.lastDraw < REFRESH_MS) return;
    this.lastDraw = now;

    const { economy } = sim;
    const book = economy.breakdown;

    this.body.innerHTML = '';

    this.body.appendChild(row('残高', formatMoney(economy.balance), economy.balance < 0));
    this.body.appendChild(row('借入残高', formatMoney(economy.debt), economy.debt > 0));
    this.body.appendChild(row('前日収支', signed(economy.lastDay.net), economy.lastDay.net < 0));

    this.body.appendChild(heading('前日の内訳'));
    this.body.appendChild(row('　住宅税', formatMoney(book.residentialTax)));
    this.body.appendChild(row('　商業税', formatMoney(book.commercialTax)));
    this.body.appendChild(row('　工業税', formatMoney(book.industrialTax)));
    this.body.appendChild(row('　オフィス税', formatMoney(book.officeTax)));
    this.body.appendChild(row('　維持費', `-${formatMoney(book.upkeep)}`, book.upkeep > 0));
    this.body.appendChild(row('　利息', `-${formatMoney(book.interest)}`, book.interest > 0));

    this.body.appendChild(heading('税率'));
    for (const [key, label] of CATEGORIES) {
      this.body.appendChild(this.rateRow(key, label, economy.rates[key]));
    }

    this.body.appendChild(heading('借入'));
    const loans = document.createElement('div');
    loans.className = 'budget-actions';
    loans.append(
      action(`${formatMoney(LOAN_TRANCHE)} 借りる`, () => this.cb.onBorrow()),
      action(`${formatMoney(LOAN_TRANCHE)} 返す`, () => this.cb.onRepay()),
    );
    this.body.appendChild(loans);
  }

  private rateRow(key: keyof TaxRates, label: string, rate: number): HTMLElement {
    const el = document.createElement('div');
    el.className = 'budget-rate';

    const name = document.createElement('span');
    name.className = 'stat-key';
    name.textContent = label;

    const value = document.createElement('span');
    value.className = 'stat-value';
    value.textContent = formatPercent(rate);

    const [min, max] = TAX_RATE_LIMITS;
    const minus = action('−', () => this.cb.onRate(key, -0.01));
    const plus = action('＋', () => this.cb.onRate(key, 0.01));
    minus.disabled = rate <= min;
    plus.disabled = rate >= max;

    el.append(name, minus, value, plus);
    return el;
  }
}

function heading(text: string): HTMLElement {
  const h = document.createElement('h3');
  h.textContent = text;
  return h;
}

function row(label: string, value: string, warn = false): HTMLElement {
  const el = document.createElement('div');
  el.className = 'stat-row';
  const k = document.createElement('span');
  k.className = 'stat-key';
  k.textContent = label;
  const v = document.createElement('span');
  v.className = warn ? 'stat-value warn' : 'stat-value';
  v.textContent = value;
  el.append(k, v);
  return el;
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${formatMoney(value)}`;
}

function action(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'small';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}
