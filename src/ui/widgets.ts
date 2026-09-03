/**
 * The handful of shapes every panel is built out of: a labelled row, a
 * proportion bar, a heading, a note, and the "？" that hides an explanation
 * until it is asked for.
 *
 * They live here rather than being redefined in each panel so that a number in
 * the finance window and a number in the statistics window line up, wrap and
 * align the same way -- which is most of what makes a set of panels read as
 * one interface rather than four.
 */

import { iconMarkup } from './icons';

export function section(title: string, children: HTMLElement[]): HTMLElement {
  const wrap = document.createElement('section');
  const h = document.createElement('h3');
  h.textContent = title;
  wrap.append(h, ...children);
  return wrap;
}

export function heading(text: string): HTMLElement {
  const h = document.createElement('h3');
  h.textContent = text;
  return h;
}

export function row(label: string, value: string, warn = false): HTMLElement {
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

/** A labelled proportion bar; the number is always shown next to it. */
export function bar(label: string, value: number, total: number, color: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'stat-bar';

  const k = document.createElement('span');
  k.className = 'stat-key';
  k.textContent = label;

  const track = document.createElement('div');
  track.className = 'stat-track';
  const fill = document.createElement('div');
  fill.style.width = `${total === 0 ? 0 : Math.round(Math.min(1, value / total) * 100)}%`;
  fill.style.background = color;
  track.appendChild(fill);

  const v = document.createElement('span');
  v.className = 'stat-value';
  v.textContent = `${value}`;

  el.append(k, track, v);
  return el;
}

export function note(text: string): HTMLElement {
  const el = document.createElement('p');
  el.className = 'stat-note';
  el.textContent = text;
  return el;
}

export function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

/**
 * True while the player is typing into a field inside this element.
 *
 * The panels are rebuilt from the simulation several times a second, which is
 * right for a readout and wrong for a text field: replacing the input
 * mid-word drops focus, and every keystroke after that reaches the toolbar's
 * shortcut handler instead -- so typing a line's name silently switched tools
 * and toggled overlays.
 *
 * Deliberately only text fields. A focused *button* must not stop the panel
 * updating: a button keeps focus after it is clicked, so treating that as
 * "the player is busy" freezes the panel until they click somewhere else --
 * which is exactly what expanding a line in the lines window does.
 */
export function holdsFocus(body: HTMLElement): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLInputElement) && !(active instanceof HTMLTextAreaElement)) {
    return false;
  }
  if (active instanceof HTMLInputElement && active.type !== 'text') return false;
  return body.contains(active);
}

export interface Help {
  /** The "？" itself, for the heading or the row it belongs to. */
  button: HTMLButtonElement;
  /** The explanation, hidden until the "？" is pressed. */
  body: HTMLElement;
}

/**
 * The "？"s a panel has already built, kept across rebuilds of its body.
 *
 * A panel body is rebuilt from the simulation several times a second, so a
 * button created afresh each time is a different element between the player's
 * mouse-down and their mouse-up -- and the click, which the browser only fires
 * when both landed on the same element, never arrives. Handing back the same
 * two elements to be moved into the new body fixes that, and carries whether
 * the explanation was open along with it.
 */
export class HelpState {
  private readonly built = new Map<string, Help>();

  remember(key: string, text: string): Help {
    const existing = this.built.get(key);
    if (existing) return existing;
    const made = buildHelp(text);
    this.built.set(key, made);
    return made;
  }
}

/**
 * A "？" button and the paragraph it reveals.
 *
 * The panels used to explain themselves in prose sitting permanently next to
 * the numbers -- how the electricity grid follows the roads, what raises land
 * value, what to do about each warning. Useful once, then noise forever: on a
 * screen where every panel is a live readout, a paragraph that never changes
 * is the thing the eye has to skip past to reach the figure that did. The text
 * is all still here, one click away, and nothing is on screen until the player
 * asks the question.
 *
 * The two halves are returned separately because the button belongs on the
 * heading row and the text belongs underneath it. Panels that rebuild their
 * body pass their own `HelpState`; `key` distinguishes two explanations that
 * happen to read the same.
 */
export function help(text: string, state?: HelpState, key: string = text): Help {
  return state ? state.remember(key, text) : buildHelp(text);
}

function buildHelp(text: string): Help {
  const body = document.createElement('p');
  body.className = 'help-text';
  body.textContent = text;
  body.hidden = true;

  const button = document.createElement('button');
  button.className = 'help-button';
  button.innerHTML = iconMarkup('help');
  button.title = '説明';
  button.setAttribute('aria-label', '説明');
  button.addEventListener('click', () => {
    body.hidden = !body.hidden;
    button.classList.toggle('active', !body.hidden);
  });

  return { button, body };
}

/** A subheading with its own "？", for the parts of a panel that need one. */
export function subheading(
  text: string,
  explanation?: string,
  state?: HelpState,
  key?: string,
): HTMLElement[] {
  const h = document.createElement('h3');
  h.textContent = text;
  if (explanation === undefined) return [h];
  const { button, body } = help(explanation, state, key);
  h.classList.add('with-help');
  h.appendChild(button);
  return [h, body];
}
