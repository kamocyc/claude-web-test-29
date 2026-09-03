import { ticksToMinutes } from '../core/clock';
import { tileX, tileY } from '../core/grid';
import { IncidentKind } from '../sim/emergency';
import type { Simulation } from '../sim/simulation';
import { bar, note, row, section } from './widgets';

const REFRESH_MS = 250;

/** Shown by the window's "？". */
export const SERVICES_HELP = '学校と消防は「道路をたどって届くか」で決まります（川の向こうは届きません）。'
  + '警察は範囲ではなく治安の場です。到着時間はプレイヤーが敷いた道路と渋滞そのものなので、'
  + '署の位置より「そこから走れるか」が効きます。';

/**
 * The civic half of the city: who the schools reach, who the fire brigade can
 * get to, how safe the streets are, and what is happening right now.
 *
 * The live incident list is the part worth having. Coverage percentages are a
 * plan; a fire with four minutes left on it is the game, and the panel puts
 * the two next to each other so the player can see that the district they
 * never connected is the district currently burning.
 */
export class ServicesPanel {
  private readonly body: HTMLElement;
  private lastDraw = 0;

  constructor(root: HTMLElement) {
    root.innerHTML = '';
    this.body = document.createElement('div');
    root.append(this.body);
  }

  update(sim: Simulation, now = performance.now()): void {
    if (now - this.lastDraw < REFRESH_MS) return;
    this.lastDraw = now;

    const s = sim.services.report;
    const e = sim.emergency.report;

    this.body.innerHTML = '';
    this.body.append(
      section('施設', [
        row('学校', `${s.schools} 校`),
        row('消防署', `${s.fireStations} か所`, s.fireStations === 0),
        row('警察署', `${s.policeStations} か所`, s.policeStations === 0),
      ]),
      section('とどく範囲', [
        bar('学校', s.schooled, Math.max(1, s.homes), '#7ec8a9'),
        bar('消防', s.fireCovered, Math.max(1, s.homes), '#e05c5c'),
        row('住宅', `${s.homes} 軒`),
        row('平均学歴', `${Math.round(s.education)} / 100`),
      ]),
      section('治安', [
        row('住宅地の犯罪度', `${Math.round(sim.crime.meanResidential(sim.world))} / 100`),
        row('本日の発生', `${e.crimesToday} 件`),
        row('　うち解決', `${e.crimesSolvedToday} 件`),
      ]),
      section('火災', [
        row('本日の出火', `${e.firesToday} 件`),
        row('焼失した建物', `${e.buildingsLostToday} 件`, e.buildingsLostToday > 0),
        row('平均到着時間', e.meanResponseTicks === 0
          ? '—'
          : `${Math.round(ticksToMinutes(e.meanResponseTicks))} 分`),
        row('出動中', `${e.unitsOut} 台`),
      ]),
      this.incidents(sim),
    );
  }

  /** What is happening right now, oldest first: the ones running out of time. */
  private incidents(sim: Simulation): HTMLElement {
    const live = sim.emergency.active;
    if (live.length === 0) return section('いま起きていること', [note('なし')]);

    const rows = live.slice(0, 8).map((incident) => {
      const left = Math.max(0, incident.deadlineTick - sim.clock.tick);
      const answered = incident.unit >= 0;
      return row(
        incident.kind === IncidentKind.Fire ? '火災' : '盗難',
        `${address(incident.tile)}　残り${Math.round(ticksToMinutes(left))}分`
        + (answered ? '（出動中）' : '（未出動）'),
        !answered,
      );
    });
    if (live.length > rows.length) rows.push(note(`ほか ${live.length - rows.length} 件`));
    return section('いま起きていること', rows);
  }
}

function address(tile: number): string {
  return `(${tileX(tile)}, ${tileY(tile)})`;
}
