import { POWER_PLANT_OUTPUT } from '../config';
import type { Simulation } from '../sim/simulation';
import { note, row, section } from './widgets';

const REFRESH_MS = 250;

/**
 * The electricity window: how much the city makes, how much it needs, and --
 * the number the player actually has to act on -- how much is missing.
 *
 * Shortage is shown per road network as well as in total, because power does
 * not travel between two road networks that do not touch. A city with a spare
 * plant in the north and a dark mining outpost in the south is short of power
 * even though its totals balance, and a single "supply vs demand" line would
 * say everything was fine while a quarter of the map sat dark.
 */
export class PowerPanel {
  private readonly body: HTMLElement;
  private lastDraw = 0;

  constructor(root: HTMLElement) {
    root.innerHTML = '';
    this.body = document.createElement('div');
    root.appendChild(this.body);
  }

  update(sim: Simulation, now = performance.now()): void {
    if (now - this.lastDraw < REFRESH_MS) return;
    this.lastDraw = now;

    const report = sim.power.report;
    const headroom = report.supply - report.demand;

    this.body.innerHTML = '';
    this.body.append(
      section('街全体', [
        row('供給', `${Math.round(report.supply)}`),
        row('需要', `${Math.round(report.demand)}`),
        row(
          '不足',
          report.shortfall > 0 ? `${Math.round(report.shortfall)}` : 'なし',
          report.shortfall > 0,
        ),
        row(
          '余力',
          headroom >= 0 ? `${Math.round(headroom)}` : `${Math.round(headroom)}`,
          headroom < 0,
        ),
        row('発電所', `${report.plants} か所（1か所あたり ${POWER_PLANT_OUTPUT}）`),
        row('停電中の建物', `${report.unpowered} 件`, report.unpowered > 0),
        row('　うち電力網の外', `${report.offGrid} 件`, report.offGrid > 0),
      ]),
      gauge(report.supply, report.demand),
      this.networks(sim),
      note(
        '電線は道路の下を通ります。つながっていない道路網は別々の電力網になるので、'
        + '道路でつなぐか、その地区にも発電所を建ててください。',
      ),
    );

    if (report.shortfall > 0) {
      this.body.append(
        note(`あと ${Math.ceil(report.shortfall / POWER_PLANT_OUTPUT)} か所の発電所で足ります。`),
      );
    }
  }

  /** One row per road network that has anything on it, worst shortage first. */
  private networks(sim: Simulation): HTMLElement {
    const { networks } = sim.power.report;
    if (networks.length === 0) return section('道路網ごと', [note('まだ何も建っていません。')]);

    const rows = networks.slice(0, 8).map((grid, i) => {
      const short = grid.demand - grid.supply;
      return row(
        `網 ${i + 1}`,
        `供給 ${Math.round(grid.supply)} ／ 需要 ${Math.round(grid.demand)}`
        + (short > 0 ? ` ／ 不足 ${Math.round(short)}` : ''),
        short > 0,
      );
    });
    if (networks.length > rows.length) {
      rows.push(note(`ほか ${networks.length - rows.length} 個の道路網`));
    }
    return section('道路網ごと', rows);
  }
}

/**
 * Supply against demand as one bar, because the ratio is the thing: a city at
 * 95% is about to have a problem and a bar shows that at a glance in a way two
 * numbers do not.
 */
function gauge(supply: number, demand: number): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'power-gauge';

  const track = document.createElement('div');
  track.className = 'power-track';
  const used = document.createElement('div');
  const ratio = supply === 0 ? (demand > 0 ? 1 : 0) : Math.min(1.5, demand / supply);
  used.style.width = `${Math.min(100, ratio * 100)}%`;
  used.style.background = ratio > 1 ? '#ff5252' : ratio > 0.85 ? '#ffb02e' : '#4ade80';
  track.appendChild(used);

  const label = document.createElement('div');
  label.className = 'power-gauge-label';
  label.textContent = supply === 0 && demand === 0
    ? '需要も供給もありません'
    : `使用率 ${Math.round(ratio * 100)}%`;

  wrap.append(track, label);
  return wrap;
}
