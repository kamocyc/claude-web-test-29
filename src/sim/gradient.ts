import { GRADE_SPEED_PENALTY, MIN_GRADE_SPEED_RATIO } from '../config';

/**
 * What a climb does to a vehicle, in one function.
 *
 * Every part of the game that cares about a hill asks this: the movement
 * model for the speed a car may hold on the segment it is on, the train loop
 * for the same, and the router for what a step of road is going to cost.
 * Written once so that the route a driver picks and the journey they then
 * have cannot disagree about how bad the hill was.
 *
 * Only climbing counts. Coasting down does not make a car faster in any way a
 * driver would accept, and crediting it would quietly make the quickest way
 * across a city the one that went over the hill rather than round it.
 */
export function gradeSpeedFactor(climb: number, sensitivity: number): number {
  if (climb <= 0) return 1;
  return Math.max(MIN_GRADE_SPEED_RATIO, 1 - GRADE_SPEED_PENALTY * climb * sensitivity);
}

/**
 * What one step of route costs, in tiles-worth of time.
 *
 * The reciprocal of the speed factor, which is to say: the time the step
 * takes. That makes the cost the same quantity the rest of the simulation
 * measures in, and it has a consequence worth stating -- a short steep way
 * over a hill can still beat a long flat way round, exactly as it does for a
 * driver who does not care how hard the engine is working. What the gradient
 * cost really buys is that a route with *no* climb in it wins against one
 * with a hill in the middle, which is the choice a city keeps offering.
 */
export function gradeStepCost(climb: number, sensitivity: number): number {
  return 1 / gradeSpeedFactor(climb, sensitivity);
}
