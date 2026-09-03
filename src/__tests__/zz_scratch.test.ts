import { describe, it } from 'vitest';
import {
  LEISURE_CLOSE_MINUTE, LEISURE_OPEN_MINUTE, LEISURE_TRIGGER, LEISURE_WINDOW_MINUTES,
} from '../config';
import { CitizenState } from '../core/types';
import { Simulation } from '../sim/simulation';
import { inDepartureWindow, isRestDay, leisureMinute } from '../sim/schedule';
import { newGame } from '../world/scenario';

describe('scratch perf', () => {
  it('counts chooseVenue-eligible citizens per tick', () => {
    const world = newGame();
    const sim = new Simulation(world);
    let peak = 0;
    let sum = 0;
    let ticks = 0;
    const t0 = Date.now();
    for (let i = 0; i < 60000; i++) {
      sim.tick();
      const minute = sim.clock.minuteOfDay;
      let n = 0;
      for (const c of world.citizens) {
        if (c.state !== CitizenState.AtHome) continue;
        if (c.leisure > LEISURE_TRIGGER) continue;
        if (sim.clock.tick < c.nextLeisureTick) continue;
        if (minute < LEISURE_OPEN_MINUTE || minute > LEISURE_CLOSE_MINUTE) continue;
        if (!inDepartureWindow(minute, leisureMinute(c.seed), LEISURE_WINDOW_MINUTES)
          && !isRestDay(c.seed, sim.clock.day)) continue;
        n++;
      }
      peak = Math.max(peak, n);
      sum += n;
      ticks++;
    }
    console.log('pop', world.population, 'buildings', world.buildings.length,
      'day', sim.clock.day, 'peak eligible/tick', peak,
      'mean eligible/tick', (sum / ticks).toFixed(1),
      'peak scan ops/tick', peak * world.buildings.length,
      'wallclock ms', Date.now() - t0);
  }, 200000);
});
