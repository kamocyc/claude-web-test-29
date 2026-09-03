import { EDUCATION_PER_HOUR } from '../config';
import { Service, type Services } from './services';
import type { World } from '../world/world';

/**
 * Teach the children of every household a school can actually reach.
 *
 * Education is per citizen rather than per district, and it never falls: what
 * somebody was taught they keep, even if the school later closes or they move
 * across town. That is what makes a school an investment with a payback period
 * -- the city pays the upkeep for days before the wages (and the tax on them)
 * catch up, and the benefit outlives the building.
 *
 * Run hourly, with the rest of the slow city.
 */
export function educate(world: World, services: Services): void {
  for (const c of world.citizens) {
    if (c.education >= 100) continue;
    const home = world.buildings[c.home];
    if (!home || !home.alive) continue;
    if (!services.serves(Service.School, home)) continue;
    c.education = Math.min(100, c.education + EDUCATION_PER_HOUR);
  }
}

/** Mean education of the people working here, 0..100. Empty means untaught. */
export function workforceEducation(world: World, occupants: readonly number[]): number {
  if (occupants.length === 0) return 0;
  let total = 0;
  for (const id of occupants) {
    const c = world.citizens[id];
    if (c) total += c.education;
  }
  return total / occupants.length;
}
