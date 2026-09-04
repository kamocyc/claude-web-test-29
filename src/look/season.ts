/**
 * The two classifications the vendored look needs from the world it came from.
 *
 * Copied rather than imported: they were a couple of small enums in a much
 * larger file of game rules, and taking that file would drag in a tile world
 * this city does not have. What is kept is exactly what the palette reads --
 * which season it is, and whether the ground under a plant is forest floor.
 */

export const Season = {
  Spring: 0,
  Summer: 1,
  Autumn: 2,
  Winter: 3,
} as const;
export type Season = (typeof Season)[keyof typeof Season];

export const SEASON_NAMES_JA: Record<Season, string> = {
  [Season.Spring]: '春',
  [Season.Summer]: '夏',
  [Season.Autumn]: '秋',
  [Season.Winter]: '冬',
};

/** The ground a plant stands on, which is all the palette asks about it. */
export const Terrain = {
  Plain: 0,
  Forest: 2,
} as const;
export type Terrain = (typeof Terrain)[keyof typeof Terrain];

/**
 * Which season a given day of the city's life falls in.
 *
 * A season is a quarter of a sim year, and a sim year is deliberately short
 * -- the point of seasons here is to show that time is passing, and a player
 * who never sees autumn learns nothing from it.
 */
export const DAYS_PER_SEASON = 24;

export function seasonOnDay(day: number): Season {
  const index = Math.floor(day / DAYS_PER_SEASON) % 4;
  return ((index + 4) % 4) as Season;
}
