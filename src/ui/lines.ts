import { ticksToMinutes } from '../core/clock';
import { tileX, tileY } from '../core/grid';
import type { Simulation } from '../sim/simulation';
import type { TileIndex } from '../core/types';
import {
  expectedWaitTicks,
  lapTicks,
  lineSpec,
  LineMode,
  type TransitLine,
} from '../world/transit';
import { World } from '../world/world';
import { button, note, row, section } from './widgets';

/** Shown by the window's "？". */
export const LINES_HELP = '街のすべての路線・系統がここにあります。'
  + '行をクリックすると地図でその路線だけが強調され、停留所の一覧が出ます。'
  + '増便すると待ち時間が半分になる代わりに車両が増え、'
  + '「停留所を編集」を押すと、いまの停留所が選択された状態で路線ツールに切り替わります。'
  + 'そこで駅を足したり外したりして「この順で開業する」を押すと、'
  + '名前・色・のべ乗車人数を保ったまま経路だけが引き直されます。';

const REFRESH_MS = 250;

export interface LinesCallbacks {
  onRename(line: number, name: string): void;
  onRecolor(line: number): void;
  onAddVehicle(line: number): void;
  onRemoveVehicle(line: number): void;
  onWithdraw(line: number): void;
  /** Put the line's stops back in the hand of the line tool, to be edited. */
  onEditStops(line: number): void;
  onShowTile(tile: TileIndex): void;
}

/**
 * Every service the city runs, and the controls for changing it.
 *
 * The city could already *build* lines and could already be told, in the
 * statistics window, how many people rode each one -- and that was the whole
 * of it. A line was a thing you created and then lived with: no way to see
 * which stops it called at without clicking each one on the map, no way to
 * discover that a route the city had grown past needed one more stop, and no
 * way to answer the one question a transport operator actually asks, which is
 * "should this line be running more vehicles?".
 *
 * So the panel puts the answer to that question next to the button that acts
 * on it. Every figure in a row is measured the way the simulation measures it
 * -- the wait is the planner's own expected wait, the round trip is the one
 * the ETA is quoted from -- so a player who adds a train can watch the number
 * they were unhappy with move.
 */
export class LinesPanel {
  private readonly body: HTMLElement;
  private lastDraw = 0;
  /** Which line is expanded, or -1. Selection is also what the map draws. */
  private selected = -1;
  /** Set when the selection changes, so a click never waits for the timer. */
  private dirty = true;
  /**
   * The name being typed, kept out of the rebuild.
   *
   * The body is rebuilt several times a second, so a text field that took its
   * value from the line every time would delete what the player was halfway
   * through typing. While a rename is in progress the field owns the string
   * and the line does not.
   */
  private editingName: string | null = null;

  constructor(root: HTMLElement, private readonly cb: LinesCallbacks) {
    root.innerHTML = '';
    this.body = document.createElement('div');
    this.body.className = 'lines-body';
    root.append(this.body);
  }

  get selectedLine(): number {
    return this.selected;
  }

  /**
   * Select a line, or -1 for none. The renderer reads `selectedLine` rather
   * than being told: the highlight is a property of what the panel is
   * showing, so there is nothing to keep in step.
   */
  select(line: number): void {
    this.selected = line;
    this.editingName = null;
    this.dirty = true;
  }

  /** Called after a load, when every id the panel is holding is from a dead city. */
  clear(): void {
    this.select(-1);
  }

  update(sim: Simulation, now = performance.now()): void {
    if (!this.dirty && now - this.lastDraw < REFRESH_MS) return;
    this.lastDraw = now;
    this.dirty = false;

    const lines = sim.world.activeLines;
    // A line the player had selected can be withdrawn by the city underneath
    // them -- a bulldozed station takes its services with it.
    if (this.selected >= 0 && !lines.some((l) => l.id === this.selected)) {
      this.select(-1);
    }

    this.body.innerHTML = '';
    if (lines.length === 0) {
      this.body.append(
        note('まだ路線がありません。'),
        note('「駅」を置いてから「路線」ツールで駅を順にクリックすると鉄道が、'
          + '「バス停」と「バス系統」で路線バスが開業できます。'),
      );
      return;
    }

    const rail = lines.filter((l) => l.mode === LineMode.Rail);
    const bus = lines.filter((l) => l.mode === LineMode.Road);
    if (rail.length > 0) {
      this.body.append(section('鉄道', rail.map((l) => this.lineBlock(sim, l))));
    }
    if (bus.length > 0) {
      this.body.append(section('バス', bus.map((l) => this.lineBlock(sim, l))));
    }
  }

  /** One line: the headline row always, the detail when it is selected. */
  private lineBlock(sim: Simulation, line: TransitLine): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'line-block';
    if (line.id === this.selected) wrap.classList.add('selected');

    const head = document.createElement('button');
    head.className = 'line-head';
    head.style.setProperty('--line-color', line.color);
    const name = document.createElement('span');
    name.className = 'line-name';
    name.textContent = line.name;
    const summary = document.createElement('span');
    summary.className = 'line-summary';
    summary.textContent = `${line.stations.length}停　${line.vehicles.length}台　`
      + `乗車${aboard(sim, line)}人`;
    head.append(name, summary);
    head.addEventListener('click', () => {
      this.select(line.id === this.selected ? -1 : line.id);
    });
    wrap.appendChild(head);

    if (line.id === this.selected) wrap.append(...this.detail(sim, line));
    return wrap;
  }

  private detail(sim: Simulation, line: TransitLine): HTMLElement[] {
    const spec = lineSpec(line);
    const waiting = line.stations.reduce((n, id) => n + sim.stats.waitingAt(id), 0);
    const out: HTMLElement[] = [
      row('種別', spec.label),
      row('のべ乗車', `${line.ridership} 人`),
      row('待っている人', `${waiting} 人`),
      row('平均待ち時間', `${minutes(expectedWaitTicks(line))} 分`),
      row('一周', `${minutes(lapTicks(line))} 分`),
      row('定員', `${spec.capacity} 人 / 台`),
      this.nameEditor(line),
      this.controls(line),
      ...this.stops(sim, line),
    ];
    return out;
  }

  /** Rename: a text field that only writes back when the player says so. */
  private nameEditor(line: TransitLine): HTMLElement {
    const el = document.createElement('div');
    el.className = 'line-rename';

    const field = document.createElement('input');
    field.type = 'text';
    field.value = this.editingName ?? line.name;
    field.maxLength = 24;
    field.setAttribute('aria-label', '路線名');
    field.addEventListener('input', () => {
      this.editingName = field.value;
    });
    const commit = (): void => {
      const value = (this.editingName ?? '').trim();
      this.editingName = null;
      if (value !== '' && value !== line.name) this.cb.onRename(line.id, value);
      this.dirty = true;
    };
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') {
        this.editingName = null;
        this.dirty = true;
      }
    });

    const apply = button('改名', commit);
    apply.className = 'small';
    el.append(field, apply);
    return el;
  }

  private controls(line: TransitLine): HTMLElement {
    const el = document.createElement('div');
    el.className = 'line-actions';

    const more = small(`増便 (${line.vehicles.length}→${line.vehicles.length + 1})`,
      () => this.cb.onAddVehicle(line.id));
    more.disabled = line.vehicles.length >= World.MAX_VEHICLES;
    const fewer = small(`減便 (${line.vehicles.length}→${line.vehicles.length - 1})`,
      () => this.cb.onRemoveVehicle(line.id));
    fewer.disabled = line.vehicles.length <= 1;

    el.append(
      more,
      fewer,
      small('色を変える', () => this.cb.onRecolor(line.id)),
      small('停留所を編集', () => this.cb.onEditStops(line.id)),
      small('廃止する', () => this.cb.onWithdraw(line.id)),
    );
    return el;
  }

  /** The stops in order, each one a button that takes the camera to it. */
  private stops(sim: Simulation, line: TransitLine): HTMLElement[] {
    const list = document.createElement('div');
    list.className = 'line-stops';
    line.stations.forEach((id, order) => {
      const stop = sim.world.buildings[id];
      if (!stop || !stop.alive) return;
      const b = small(
        `${order + 1}. ${address(stop.tile)}　${sim.stats.waitingAt(id)}人待ち`,
        () => this.cb.onShowTile(stop.tile),
      );
      b.classList.add('line-stop');
      list.appendChild(b);
    });
    const heading = document.createElement('h4');
    heading.textContent = '停留所（クリックで地図へ）';
    return [heading, list];
  }
}

function aboard(sim: Simulation, line: TransitLine): number {
  let n = 0;
  for (const vid of line.vehicles) {
    n += sim.world.vehicleOn(line, vid)?.passengers.length ?? 0;
  }
  return n;
}

function small(label: string, onClick: () => void): HTMLButtonElement {
  const b = button(label, onClick);
  b.className = 'small';
  return b;
}

function minutes(ticks: number): string {
  return `${Math.round(ticksToMinutes(ticks))}`;
}

function address(tile: number): string {
  return `(${tileX(tile)}, ${tileY(tile)})`;
}
