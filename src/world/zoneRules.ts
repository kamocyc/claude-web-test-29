import { neighbors } from '../core/grid';
import { Resource, Zone, type TileIndex } from '../core/types';
import type { TileMap } from './tileMap';

/**
 * What a zone needs from the ground under it.
 *
 * Primary industry is the only thing in the game that cannot be put wherever
 * the player likes, and that is deliberate: it is what turns a flat map into a
 * place with somewhere worth building. The paddies go where the river has left
 * fertile ground, the camps go in the forest, the wharves go on the shore and
 * the mines go on the seam -- and everything downstream of them has to be
 * connected back to wherever that turned out to be.
 */
export function zoneRequirement(zone: Zone): Resource | 'shore' | null {
  switch (zone) {
    case Zone.Farm:
      return Resource.Fertile;
    case Zone.Forestry:
      return Resource.Forest;
    case Zone.Mining:
      return Resource.Ore;
    case Zone.Fishery:
      return 'shore';
    default:
      return null;
  }
}

/** Whether this zone may be painted on this tile's ground. */
export function groundSupports(map: TileMap, zone: Zone, tile: TileIndex): boolean {
  const need = zoneRequirement(zone);
  if (need === null) return true;
  if (need === 'shore') return neighbors(tile).some((n) => map.isWater(n));
  return map.getResource(tile) === need;
}

/** Why a zone was refused, for the message the HUD shows. */
export function zoneRefusalReason(zone: Zone): string {
  switch (zoneRequirement(zone)) {
    case Resource.Fertile:
      return '水田は肥沃な土地（川沿い）にしか作れません';
    case Resource.Forest:
      return '林業は森林のあるタイルにしか作れません';
    case Resource.Ore:
      return '鉱業は鉱床のあるタイルにしか作れません';
    case 'shore':
      return '漁業は水に接するタイルにしか作れません';
    default:
      return '道路に接した空きタイルにしか区画を設定できません';
  }
}

export const ZONE_LABELS: Readonly<Record<Zone, string>> = {
  [Zone.None]: 'なし',
  [Zone.ResidentialLow]: '低密度住宅',
  [Zone.ResidentialHigh]: '高密度住宅',
  [Zone.Commercial]: '商業',
  [Zone.Industrial]: '工業',
  [Zone.Office]: 'オフィス',
  [Zone.Farm]: '農業（水田）',
  [Zone.Forestry]: '林業',
  [Zone.Fishery]: '漁業',
  [Zone.Mining]: '鉱業',
};
