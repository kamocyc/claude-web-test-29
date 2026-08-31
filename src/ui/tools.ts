import { Zone, type TileIndex } from '../core/types';
import type { World } from '../world/world';

export const enum Tool {
  Select = 'select',
  Road = 'road',
  Residential = 'residential',
  Commercial = 'commercial',
  Bulldoze = 'bulldoze',
}

export const TOOL_LABELS: ReadonlyArray<{ tool: Tool; label: string; key: string }> = [
  { tool: Tool.Select, label: '選択', key: '1' },
  { tool: Tool.Road, label: '道路', key: '2' },
  { tool: Tool.Residential, label: '住宅', key: '3' },
  { tool: Tool.Commercial, label: '商業', key: '4' },
  { tool: Tool.Bulldoze, label: '撤去', key: '5' },
];

export function applyTool(world: World, tool: Tool, tile: TileIndex): boolean {
  switch (tool) {
    case Tool.Road:
      return world.placeRoad(tile);
    case Tool.Residential:
      return world.paintZone(tile, Zone.Residential);
    case Tool.Commercial:
      return world.paintZone(tile, Zone.Commercial);
    case Tool.Bulldoze:
      return world.bulldoze(tile);
    case Tool.Select:
      return false;
  }
}
