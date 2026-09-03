import { iconMarkup, type IconName } from './icons';

/**
 * A floating, draggable information window.
 *
 * The panels used to be stacked in one fixed sidebar, which meant the player
 * chose between reading the city's finances and seeing the part of the map the
 * finances were about -- and everything was on screen whether it was wanted or
 * not. As windows they can be opened one at a time, moved off whatever the
 * player is watching, and closed when the question is answered.
 *
 * Deliberately not a general widget kit: a title bar, a body, drag, collapse
 * and close. Anything more would be a second UI framework living inside a
 * simulation.
 */
export class InfoWindow {
  readonly root: HTMLElement;
  readonly body: HTMLElement;

  private readonly titleEl: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly collapseButton: HTMLButtonElement;
  private collapsed = false;
  /** The explanation behind this window's "？", once one has been set. */
  private helpText: HTMLElement | null = null;
  private helpButton: HTMLButtonElement | null = null;

  /** Called whenever the window opens or closes, so a toolbar can light up. */
  onVisibilityChange: (() => void) | null = null;

  constructor(
    private readonly layer: HTMLElement,
    readonly id: string,
    title: string,
    private readonly placement: { x: number; y: number; width: number },
  ) {
    this.root = document.createElement('section');
    this.root.className = 'win';
    this.root.hidden = true;
    this.root.style.width = `${placement.width}px`;
    this.root.style.left = `${placement.x}px`;
    this.root.style.top = `${placement.y}px`;

    const bar = document.createElement('header');
    bar.className = 'win-bar';
    this.bar = bar;

    this.titleEl = document.createElement('span');
    this.titleEl.className = 'win-title';
    this.titleEl.textContent = title;

    this.collapseButton = iconButton('collapse', '折りたたむ', () => this.toggleCollapsed());
    const close = iconButton('close', '閉じる', () => this.close());

    bar.append(this.titleEl, this.collapseButton, close);

    this.body = document.createElement('div');
    this.body.className = 'win-body';

    this.root.append(bar, this.body);
    layer.appendChild(this.root);

    this.makeDraggable(bar);
    // Clicking anywhere in a window brings it to the front, so two overlapping
    // panels behave the way overlapping panels are expected to.
    this.root.addEventListener('mousedown', () => this.raise());
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  open(): void {
    if (this.isOpen) return;
    this.root.hidden = false;
    this.raise();
    this.clampIntoView();
    this.onVisibilityChange?.();
  }

  close(): void {
    if (!this.isOpen) return;
    this.root.hidden = true;
    this.onVisibilityChange?.();
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  setTitle(text: string): void {
    this.titleEl.textContent = text;
  }

  /**
   * Give this window a "？" in its title bar.
   *
   * The explanation lives here rather than in the panel body because the body
   * is rebuilt several times a second from the simulation: anything static put
   * in it would be thrown away and re-created along with the numbers, and
   * would lose whether the player had opened it. Here it is written once and
   * simply shown or hidden.
   */
  setHelp(text: string): void {
    if (this.helpText) {
      this.helpText.textContent = text;
      return;
    }
    const help = document.createElement('div');
    help.className = 'win-help';
    help.textContent = text;
    help.hidden = true;
    this.helpText = help;
    this.root.insertBefore(help, this.body);

    const button = iconButton('help', '説明', () => this.showHelp(help.hidden));
    this.helpButton = button;
    this.bar.insertBefore(button, this.collapseButton);
  }

  /** True when the window is open and its body is actually showing. */
  get isVisible(): boolean {
    return this.isOpen && !this.collapsed;
  }

  private toggleCollapsed(): void {
    this.collapsed = !this.collapsed;
    this.body.hidden = this.collapsed;
    if (this.collapsed) this.showHelp(false);
    this.collapseButton.innerHTML = iconMarkup(this.collapsed ? 'expand' : 'collapse');
  }

  private showHelp(show: boolean): void {
    if (!this.helpText || !this.helpButton) return;
    this.helpText.hidden = !show;
    this.helpButton.classList.toggle('active', show);
  }

  private raise(): void {
    for (const other of this.layer.children) {
      (other as HTMLElement).style.zIndex = '1';
    }
    this.root.style.zIndex = '2';
  }

  private makeDraggable(handle: HTMLElement): void {
    let startX = 0;
    let startY = 0;
    let originX = 0;
    let originY = 0;
    let dragging = false;

    const move = (e: MouseEvent): void => {
      if (!dragging) return;
      this.root.style.left = `${originX + (e.clientX - startX)}px`;
      this.root.style.top = `${originY + (e.clientY - startY)}px`;
    };

    const end = (): void => {
      if (!dragging) return;
      dragging = false;
      this.clampIntoView();
    };

    handle.addEventListener('mousedown', (e) => {
      // The buttons in the title bar are not a drag handle.
      if ((e.target as HTMLElement).tagName === 'BUTTON') return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      originX = this.root.offsetLeft;
      originY = this.root.offsetTop;
      e.preventDefault();
    });
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end);
  }

  /**
   * Keep the title bar reachable. A window dragged off the edge, or left
   * behind by a shrinking window, would otherwise be impossible to get back.
   */
  clampIntoView(): void {
    // A hidden element has no offsets at all, so measuring one would report a
    // position of zero and then "correct" the window to the top-left corner --
    // which is how every closed window used to end up in one pile.
    if (!this.isOpen) return;
    const bounds = this.layer.getBoundingClientRect();
    const width = this.root.offsetWidth || this.placement.width;
    const maxX = Math.max(0, bounds.width - width);
    const maxY = Math.max(0, bounds.height - 40);
    this.root.style.left = `${Math.min(maxX, Math.max(0, this.root.offsetLeft))}px`;
    this.root.style.top = `${Math.min(maxY, Math.max(0, this.root.offsetTop))}px`;
  }
}

function iconButton(name: IconName, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'win-icon';
  b.innerHTML = iconMarkup(name);
  b.title = title;
  b.setAttribute('aria-label', title);
  b.addEventListener('click', onClick);
  return b;
}
