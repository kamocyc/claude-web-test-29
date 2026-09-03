import {
  HEALTH_CRIME_PENALTY,
  HEALTH_NOISE_PENALTY,
  HEALTH_RECOVERY,
  HEALTH_WITHOUT_HOSPITAL,
  HEALTH_WITH_HOSPITAL,
} from '../config';
import type { CrimeField } from './crime';
import type { NoiseField } from './noise';
import { Service, type Services } from './services';
import type { Policies } from './policies';
import type { World } from '../world/world';

/**
 * How healthy the residents are, and why.
 *
 * Education's opposite number, and deliberately not modelled like it.
 * Education only ever rises -- what somebody was taught they keep -- so a
 * school built once keeps paying for itself. Health is a running balance
 * between where a household lives and whether a hospital can reach it, so it
 * *falls back* the moment either stops being true: close the hospital, or put
 * an arterial road past the front door, and the number goes the other way.
 *
 * That asymmetry is the whole reason the two are separate systems rather than
 * one "civic score". A school is an investment; a hospital is a commitment.
 */
export function treat(
  world: World,
  services: Services,
  noise: NoiseField,
  crime: CrimeField,
  policies: Policies,
): void {
  for (const c of world.citizens) {
    const home = world.buildings[c.home];
    if (!home || !home.alive) continue;
    const target = healthTarget(services, noise, crime, policies, home.tile, home);
    c.health += (target - c.health) * HEALTH_RECOVERY;
  }
}

/**
 * Where a household's health is heading, 0..100.
 *
 * Exported because the inspector shows the same figure for the tile under the
 * cursor: what the panel says is pulling somebody's health down has to be the
 * thing that is actually pulling it down.
 */
export function healthTarget(
  services: Services,
  noise: NoiseField,
  crime: CrimeField,
  policies: Policies,
  tile: number,
  home: { accessRoad: number },
): number {
  const covered = services.covers(Service.Health, home.accessRoad);
  const base = covered
    ? HEALTH_WITH_HOSPITAL + policies.healthBonus
    : HEALTH_WITHOUT_HOSPITAL;
  const environment = (noise.at(tile) / 100) * HEALTH_NOISE_PENALTY
    + (crime.at(tile) / 100) * HEALTH_CRIME_PENALTY;
  return clamp(base - environment);
}

function clamp(v: number): number {
  return Math.min(100, Math.max(0, v));
}
