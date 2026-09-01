import { Zone, type TileIndex } from '../core/types';
import type { World } from '../world/world';

export const enum Tool {
  Select = 'select',
  Road = 'road',
  Residential = 'residential',
  Commercial = 'commercial',
  Rail = 'rail',
  Station = 'station',
  Line = 'line',
  Bulldoze = 'bulldoze',
}

export const TOOL_LABELS: ReadonlyArray<{ tool: Tool; label: string; key: string }> = [
  { tool: Tool.Select, label: '選択', key: '1' },
  { tool: Tool.Road, label: '道路', key: '2' },
  { tool: Tool.Residential, label: '住宅', key: '3' },
  { tool: Tool.Commercial, label: '商業', key: '4' },
  { tool: Tool.Rail, label: '線路', key: '5' },
  { tool: Tool.Station, label: '駅', key: '6' },
  { tool: Tool.Line, label: '路線', key: '7' },
  { tool: Tool.Bulldoze, label: '撤去', key: '8' },
];

export const TOOL_BY_KEY: Readonly<Record<string, Tool>> = Object.fromEntries(
  TOOL_LABELS.map(({ tool, key }) => [key, tool]),
);

/** Tools that paint continuously while the mouse is dragged. */
export function isDragTool(tool: Tool): boolean {
  return (
    tool === Tool.Road ||
    tool === Tool.Rail ||
    tool === Tool.Residential ||
    tool === Tool.Commercial ||
    tool === Tool.Bulldoze
  );
}

export function applyTool(world: World, tool: Tool, tile: TileIndex): boolean {
  switch (tool) {
    case Tool.Road:
      return world.placeRoad(tile);
    case Tool.Rail:
      return world.placeRail(tile);
    case Tool.Residential:
      return world.paintZone(tile, Zone.Residential);
    case Tool.Commercial:
      return world.paintZone(tile, Zone.Commercial);
    case Tool.Station:
      return world.placeStation(tile) !== null;
    case Tool.Bulldoze:
      return world.bulldoze(tile);
    case Tool.Select:
    case Tool.Line:
      return false;
  }
}
