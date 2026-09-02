export const COLORS = {
  background: '#11161c',
  grass: '#2c4a32',
  grassAlt: '#2f4f36',
  water: '#1b3a54',
  road: '#3d4148',
  roadLine: '#585d66',
  rail: '#4a4038',
  railTie: '#7a6a56',
  station: '#c8b6e2',
  stationPending: '#ffe066',
  platform: 'rgba(200, 182, 226, 0.35)',
  residence: '#5fa8d3',
  apartment: '#3f7fb8',
  commerce: '#e0a458',
  industry: '#d17a4a',
  office: '#9b8ce0',
  farm: '#8fc95c',
  forestry: '#3f8f52',
  fishery: '#4fc5c0',
  mining: '#b0895f',
  power: '#f0d24a',

  // Zones are washes over bare ground, so they must stay faint enough that the
  // buildings growing on them remain the thing the eye lands on.
  zoneResidentialLow: 'rgba(95, 168, 211, 0.22)',
  zoneResidentialHigh: 'rgba(63, 127, 184, 0.3)',
  zoneCommercial: 'rgba(224, 164, 88, 0.22)',
  zoneIndustrial: 'rgba(209, 122, 74, 0.22)',
  zoneOffice: 'rgba(155, 140, 224, 0.22)',
  zoneFarm: 'rgba(143, 201, 92, 0.22)',
  zoneForestry: 'rgba(63, 143, 82, 0.28)',
  zoneFishery: 'rgba(79, 197, 192, 0.22)',
  zoneMining: 'rgba(176, 137, 95, 0.24)',

  // The ground itself: what the primary industries need.
  forestGround: '#26472c',
  forestTree: '#1e6b33',
  oreGround: '#453b31',
  oreSpeck: '#8a7a5a',
  fertileGround: '#3b5a33',
  pedestrian: '#d8dee9',
  carNose: '#fdf6d8',
  carTail: '#3a2020',
  signalGreen: '#3ddc7f',
  signalRed: '#ff4d5e',
  badgeBackground: 'rgba(13, 17, 23, 0.82)',
  badgeText: '#f2f5f9',
  stranded: '#ff4d5e',
  selection: '#ffe066',
  hover: 'rgba(255, 255, 255, 0.28)',
  path: 'rgba(255, 224, 102, 0.85)',
  powered: '#3ddc7f',
  unpowered: '#ff4d5e',
  noise: '#ff7a45',
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
