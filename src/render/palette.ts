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
  commerce: '#e0a458',
  zoneResidential: 'rgba(95, 168, 211, 0.22)',
  zoneCommercial: 'rgba(224, 164, 88, 0.22)',
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
} as const;

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
