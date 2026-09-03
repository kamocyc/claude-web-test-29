/**
 * The handful of shapes every panel is built out of: a labelled row, a
 * proportion bar, a heading, a note.
 *
 * They live here rather than being redefined in each panel so that a number in
 * the finance window and a number in the statistics window line up, wrap and
 * align the same way -- which is most of what makes a set of panels read as
 * one interface rather than four.
 */

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
