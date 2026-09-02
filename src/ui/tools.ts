import { Zone, type TileIndex } from '../core/types';
import { Expense, type Economy } from '../sim/economy';
import type { World } from '../world/world';
import { zoneRefusalReason } from '../world/zoneRules';

export const enum Tool {
  Select = 'select',
  Road = 'road',
  Rail = 'rail',
  Station = 'station',
  Line = 'line',
  Power = 'power',
  Bulldoze = 'bulldoze',
  ResidentialLow = 'residentialLow',
  ResidentialHigh = 'residentialHigh',
  Commercial = 'commercial',
  Industrial = 'industrial',
  Office = 'office',
  Farm = 'farm',
  Forestry = 'forestry',
  Fishery = 'fishery',
  Mining = 'mining',
}

/** The zone a zoning tool paints, or null for the tools that build things. */
export function zoneOf(tool: Tool): Zone | null {
  switch (tool) {
    case Tool.ResidentialLow:
      return Zone.ResidentialLow;
    case Tool.ResidentialHigh:
      return Zone.ResidentialHigh;
    case Tool.Commercial:
      return Zone.Commercial;
    case Tool.Industrial:
      return Zone.Industrial;
    case Tool.Office:
      return Zone.Office;
    case Tool.Farm:
      return Zone.Farm;
    case Tool.Forestry:
      return Zone.Forestry;
    case Tool.Fishery:
      return Zone.Fishery;
    case Tool.Mining:
      return Zone.Mining;
    default:
      return null;
  }
}

export interface ToolInfo {
  tool: Tool;
  label: string;
  /** Keyboard shortcut, or '' for tools that only have a button. */
  key: string;
  /** Which row of the toolbar it belongs to. */
  group: 'build' | 'zone';
}

export const TOOL_LABELS: ReadonlyArray<ToolInfo> = [
  { tool: Tool.Select, label: '選択', key: '1', group: 'build' },
  { tool: Tool.Road, label: '道路', key: '2', group: 'build' },
  { tool: Tool.Rail, label: '線路', key: '3', group: 'build' },
  { tool: Tool.Station, label: '駅', key: '4', group: 'build' },
  { tool: Tool.Line, label: '路線', key: '5', group: 'build' },
  { tool: Tool.Power, label: '発電所', key: '6', group: 'build' },
  { tool: Tool.Bulldoze, label: '撤去', key: '7', group: 'build' },

  { tool: Tool.ResidentialLow, label: '低密度住宅', key: 'q', group: 'zone' },
  { tool: Tool.ResidentialHigh, label: '高密度住宅', key: 'w', group: 'zone' },
  { tool: Tool.Commercial, label: '商業', key: 'e', group: 'zone' },
  { tool: Tool.Industrial, label: '工業', key: 'r', group: 'zone' },
  { tool: Tool.Office, label: 'オフィス', key: 't', group: 'zone' },
  { tool: Tool.Farm, label: '農業', key: 'a', group: 'zone' },
  { tool: Tool.Forestry, label: '林業', key: 's', group: 'zone' },
  { tool: Tool.Fishery, label: '漁業', key: 'd', group: 'zone' },
  { tool: Tool.Mining, label: '鉱業', key: 'f', group: 'zone' },
];

export const TOOL_BY_KEY: Readonly<Record<string, Tool>> = Object.fromEntries(
  TOOL_LABELS.filter((t) => t.key !== '').map(({ tool, key }) => [key, tool]),
);

/** Tools that paint continuously while the mouse is dragged. */
export function isDragTool(tool: Tool): boolean {
  return tool === Tool.Road || tool === Tool.Rail || tool === Tool.Bulldoze
    || zoneOf(tool) !== null;
}

/** What one use of this tool costs the city. */
export function expenseOf(tool: Tool): Expense | null {
  switch (tool) {
    case Tool.Road:
      return Expense.Road;
    case Tool.Rail:
      return Expense.Rail;
    case Tool.Station:
      return Expense.Station;
    case Tool.Power:
      return Expense.PowerPlant;
    case Tool.Bulldoze:
      return Expense.Bulldoze;
    default:
      return zoneOf(tool) !== null ? Expense.Zone : null;
  }
}

export interface ToolResult {
  applied: boolean;
  /** Set when the action was refused for a reason worth telling the player. */
  message?: string;
}

/**
 * Apply a tool, charging for it.
 *
 * Money is taken only when the action actually changes the map, which matters
 * far more than it sounds: painting a zone is a drag gesture that passes over
 * dozens of tiles that are already that zone, or are water, or are already
 * built on. Charging per attempt rather than per change would empty the
 * treasury for nothing and make dragging feel like a punishment.
 */
export function applyTool(
  world: World,
  economy: Economy,
  tool: Tool,
  tile: TileIndex,
): ToolResult {
  const expense = expenseOf(tool);
  if (expense !== null && !economy.canAfford(expense)) {
    return { applied: false, message: '資金が足りません' };
  }

  const zone = zoneOf(tool);
  if (zone !== null) {
    if (!world.canZone(tile, zone)) {
      return { applied: false, message: zoneRefusalReason(zone) };
    }
    if (!world.paintZone(tile, zone)) return { applied: false };
    economy.charge(Expense.Zone);
    return { applied: true };
  }

  switch (tool) {
    case Tool.Road:
      return charged(world.placeRoad(tile), economy, Expense.Road);
    case Tool.Rail:
      return charged(world.placeRail(tile), economy, Expense.Rail);
    case Tool.Station: {
      const built = world.placeStation(tile) !== null;
      if (!built) return { applied: false, message: '駅は道路に接する空きタイルにしか置けません' };
      economy.charge(Expense.Station);
      return { applied: true };
    }
    case Tool.Power: {
      const built = world.placePowerPlant(tile) !== null;
      if (!built) {
        return { applied: false, message: '発電所は道路に接する空きタイルにしか置けません' };
      }
      economy.charge(Expense.PowerPlant);
      return { applied: true };
    }
    case Tool.Bulldoze:
      return charged(world.bulldoze(tile), economy, Expense.Bulldoze);
    case Tool.Select:
    case Tool.Line:
      return { applied: false };
    default:
      return { applied: false };
  }
}

function charged(changed: boolean, economy: Economy, expense: Expense): ToolResult {
  if (!changed) return { applied: false };
  economy.charge(expense);
  return { applied: true };
}
