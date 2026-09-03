import { tileX, tileY } from '../core/grid';
import { cityWarnings, type CityWarning } from '../sim/diagnostics';
import type { Simulation } from '../sim/simulation';
import type { TileIndex } from '../core/types';
import { help, HelpState, note } from './widgets';

/** Shown by the window's "？". */
export const WARNINGS_HELP = '重いものから順に並んでいます。各行の「？」に対処法、'
  + '「(x, y) を見る」で現場へカメラが飛びます。地図の上に出るバッジも同じ判定です。';

const REFRESH_MS = 400;

export interface WarningCallbacks {
  /** Take the camera to the place a warning is about. */
  onShowMe(tile: TileIndex): void;
}

/**
 * Everything wrong with the city, in one list, worst first.
 *
 * The toolbar can only ever show the single most urgent complaint, which is
 * exactly the wrong amount of information when three things are wrong at once:
 * the player fixes the loudest one and the next one appears, with no sense of
 * how much is broken. Here they are all visible, each with -- where there is a
 * specific building at fault -- a button that takes the camera to it, because
 * "12件の建物に電気が来ていません" is not much use if you cannot find them.
 *
 * What to do about a warning is a sentence, and eight sentences stacked up is
 * a page of text rather than a list of problems, so each line keeps its advice
 * behind its own "？".
 */
export class WarningsPanel {
  private readonly body: HTMLElement;
  private lastDraw = 0;
  private lastSignature = '';
  /** The "？" of each warning, kept across rebuilds of the list. */
  private readonly helpState = new HelpState();

  constructor(root: HTMLElement, private readonly cb: WarningCallbacks) {
    root.innerHTML = '';
    this.body = document.createElement('div');
    this.body.className = 'warning-list';
    root.appendChild(this.body);
  }

  update(sim: Simulation, now = performance.now()): void {
    if (now - this.lastDraw < REFRESH_MS) return;
    this.lastDraw = now;

    const warnings = cityWarnings(sim);
    // Rebuilding the list under the cursor would swallow the click that is
    // half way through happening, so it only redraws when it has changed.
    const signature = warnings.map((w) => `${w.id}:${w.title}`).join('|');
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;

    this.body.innerHTML = '';
    if (warnings.length === 0) {
      this.body.appendChild(note('問題なし'));
      return;
    }
    for (const warning of warnings) this.body.appendChild(this.card(warning));
  }

  private card(warning: CityWarning): HTMLElement {
    const el = document.createElement('div');
    el.className = `warning warning-${warning.severity}`;

    const head = document.createElement('div');
    head.className = 'warning-head';

    const icon = document.createElement('span');
    icon.className = 'warning-icon';
    icon.textContent = warning.icon;

    const title = document.createElement('span');
    title.className = 'warning-title';
    title.textContent = warning.title;

    head.append(icon, title);

    if (warning.focus >= 0) {
      const show = document.createElement('button');
      show.className = 'small';
      show.textContent = `(${tileX(warning.focus)}, ${tileY(warning.focus)}) を見る`;
      show.addEventListener('click', () => this.cb.onShowMe(warning.focus));
      head.appendChild(show);
    }

    const advice = help(warning.advice, this.helpState, warning.id);
    advice.body.classList.add('warning-advice');
    head.appendChild(advice.button);

    el.append(head, advice.body);
    return el;
  }
}
