/**
 * The map's colours, borrowed from Cities: Skylines so that a player who
 * knows that game can read this one without being told anything.
 *
 * The zone hues are the load-bearing part: green is where people live, blue is
 * where they shop, yellow is industry, cyan is offices, and the specialised
 * industries keep their own earthy versions of those. Everything else -- the
 * ground, the roads, the water -- is deliberately desaturated so the zoning
 * and the warnings are the only saturated things on screen.
 */
export const COLORS = {
  background: '#0f1519',
  grass: '#4a7a41',
  grassAlt: '#4e8045',
  water: '#2a6ba8',
  road: '#4a5058',
  roadLine: '#6b7381',
  rail: '#4a4038',
  railTie: '#8b7a63',
  station: '#c58fe0',
  stationPending: '#ffc94a',
  platform: 'rgba(197, 143, 224, 0.35)',

  // Buildings, in the colour of the zone that grew them.
  residence: '#8ed64a',
  apartment: '#4f9e35',
  commerce: '#4fa3e3',
  industry: '#e0c33c',
  office: '#2fc4c4',
  farm: '#cbb04a',
  forestry: '#3f9a5a',
  fishery: '#46b8cf',
  mining: '#a97c52',
  power: '#f2d64b',

  // Zones are washes over bare ground, so they must stay faint enough that the
  // buildings growing on them remain the thing the eye lands on.
  zoneResidentialLow: 'rgba(140, 214, 74, 0.30)',
  zoneResidentialHigh: 'rgba(79, 158, 53, 0.36)',
  zoneCommercial: 'rgba(79, 163, 227, 0.30)',
  zoneIndustrial: 'rgba(224, 195, 60, 0.30)',
  zoneOffice: 'rgba(47, 196, 196, 0.30)',
  zoneFarm: 'rgba(203, 176, 74, 0.30)',
  zoneForestry: 'rgba(63, 154, 90, 0.34)',
  zoneFishery: 'rgba(70, 184, 207, 0.30)',
  zoneMining: 'rgba(169, 124, 82, 0.32)',

  // The ground itself: what the primary industries need.
  forestGround: '#2f5c34',
  forestTree: '#2a7d3c',
  oreGround: '#4c4136',
  oreSpeck: '#9a8862',
  fertileGround: '#5c7a35',
  pedestrian: '#e8eef5',
  carNose: '#fdf6d8',
  carTail: '#3a2020',
  signalGreen: '#4ade80',
  signalRed: '#ff5252',
  badgeBackground: 'rgba(12, 22, 31, 0.85)',
  badgeText: '#f2f5f9',
  stranded: '#ff5252',
  selection: '#ffc94a',
  hover: 'rgba(255, 255, 255, 0.32)',
  path: 'rgba(255, 201, 74, 0.85)',
  lorryBody: '#dfe6ee',
  lorryCab: '#5d6b7d',
  cargoRaw: '#a97c52',
  cargoGoods: '#4fa3e3',
  powered: '#4ade80',
  unpowered: '#ff5252',
  noise: '#ff7a45',

  // Warning badges, by how urgent the thing they are reporting is.
  alertCritical: '#ff5252',
  alertWarning: '#ffb02e',
  alertInfo: '#7fa8cc',
  alertText: '#12181d',
} as const;

/** Red (worthless) through amber to green (desirable), for the land value map. */
export function valueColor(ratio: number): string {
  const t = Math.min(1, Math.max(0, ratio));
  const r = Math.round(220 - 150 * t);
  const g = Math.round(70 + 150 * t);
  const b = Math.round(70 + 60 * t);
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * Green -> amber -> red by how close a car is to its free-flow speed. Jams are
 * not a separate quantity in this sim: this ratio is the whole story.
 */
export function speedColor(ratio: number): string {
  const t = Math.min(1, Math.max(0, ratio));
  if (t < 0.5) {
    const k = t / 0.5;
    return `rgb(${230}, ${Math.round(60 + 130 * k)}, ${60})`;
  }
  const k = (t - 0.5) / 0.5;
  return `rgb(${Math.round(230 - 140 * k)}, ${Math.round(190 + 20 * k)}, ${Math.round(60 + 60 * k)})`;
}
