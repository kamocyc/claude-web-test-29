import { COLORS } from '../render/palette';
import { MAX_RAISE } from '../config';
import { BuildingType, Zone, type TileIndex } from '../core/types';
import { LineMode } from '../world/transit';
import type { IconName } from './icons';
import { Expense, type Economy } from '../sim/economy';
import type { World } from '../world/world';
import { zoneRefusalReason } from '../world/zoneRules';

export const enum Tool {
  Select = 'select',
  Road = 'road',
  ElevatedRoad = 'elevatedRoad',
  Rail = 'rail',
  ElevatedRail = 'elevatedRail',
  Station = 'station',
  Line = 'line',
  BusStop = 'busStop',
  BusLine = 'busLine',
  Power = 'power',
  School = 'school',
  FireStation = 'fireStation',
  PoliceStation = 'policeStation',
  Hospital = 'hospital',
  Park = 'park',
  Stadium = 'stadium',
  AmusementPark = 'amusementPark',
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

/** Which cluster of the one-row toolbar a tool sits in. */
export type ToolGroup =
  | 'select'
  | 'road'
  | 'rail'
  | 'bus'
  | 'zone'
  | 'civic'
  | 'leisure'
  | 'bulldoze';

export interface ToolInfo {
  tool: Tool;
  label: string;
  /** Keyboard shortcut, or '' for tools that only have a button. */
  key: string;
  /** Which cluster of the toolbar it belongs to. */
  group: ToolGroup;
  /** The picture on its button. */
  icon: IconName;
  /**
   * For zoning tools, the colour this tool paints -- taken from the map's own
   * palette so the button and the ground can never disagree.
   */
  swatch?: string;
}

export const TOOL_LABELS: ReadonlyArray<ToolInfo> = [
  { tool: Tool.Select, label: '選択', key: '1', group: 'select', icon: 'select' },

  { tool: Tool.Road, label: '道路', key: '2', group: 'road', icon: 'road' },
  { tool: Tool.ElevatedRoad, label: '高架道路', key: 'k', group: 'road', icon: 'elevatedRoad' },

  { tool: Tool.Rail, label: '線路', key: '3', group: 'rail', icon: 'rail' },
  { tool: Tool.ElevatedRail, label: '高架線路', key: 'l', group: 'rail', icon: 'elevatedRail' },
  { tool: Tool.Station, label: '駅', key: '4', group: 'rail', icon: 'station' },
  { tool: Tool.Line, label: '路線', key: '5', group: 'rail', icon: 'line' },

  { tool: Tool.BusStop, label: 'バス停', key: '8', group: 'bus', icon: 'busStop' },
  { tool: Tool.BusLine, label: 'バス系統', key: '9', group: 'bus', icon: 'busLine' },

  {
    tool: Tool.ResidentialLow, label: '低密度住宅', key: 'q', group: 'zone',
    icon: 'zoneHouse', swatch: COLORS.residence,
  },
  {
    tool: Tool.ResidentialHigh, label: '高密度住宅', key: 'w', group: 'zone',
    icon: 'zoneApartment', swatch: COLORS.apartment,
  },
  {
    tool: Tool.Commercial, label: '商業', key: 'e', group: 'zone',
    icon: 'zoneShop', swatch: COLORS.commerce,
  },
  {
    tool: Tool.Industrial, label: '工業', key: 'r', group: 'zone',
    icon: 'zoneFactory', swatch: COLORS.industry,
  },
  {
    // Not "t": the overlay shortcuts are read first, so a tool keyed to one of
    // them can never be reached from the keyboard.
    tool: Tool.Office, label: 'オフィス', key: 'o', group: 'zone',
    icon: 'zoneOffice', swatch: COLORS.office,
  },
  {
    tool: Tool.Farm, label: '農業', key: 'a', group: 'zone',
    icon: 'zoneFarm', swatch: COLORS.farm,
  },
  {
    tool: Tool.Forestry, label: '林業', key: 's', group: 'zone',
    icon: 'zoneForest', swatch: COLORS.forestry,
  },
  {
    tool: Tool.Fishery, label: '漁業', key: 'd', group: 'zone',
    icon: 'zoneFish', swatch: COLORS.fishery,
  },
  {
    tool: Tool.Mining, label: '鉱業', key: 'f', group: 'zone',
    icon: 'zoneMine', swatch: COLORS.mining,
  },

  { tool: Tool.Power, label: '発電所', key: '6', group: 'civic', icon: 'powerPlant' },
  { tool: Tool.School, label: '学校', key: 'g', group: 'civic', icon: 'school' },
  { tool: Tool.FireStation, label: '消防署', key: 'h', group: 'civic', icon: 'fireStation' },
  { tool: Tool.PoliceStation, label: '警察署', key: 'j', group: 'civic', icon: 'policeStation' },
  { tool: Tool.Hospital, label: '病院', key: 'i', group: 'civic', icon: 'hospital' },

  { tool: Tool.Park, label: '公園', key: 'u', group: 'leisure', icon: 'park' },
  { tool: Tool.Stadium, label: '競技場', key: 'y', group: 'leisure', icon: 'stadium' },
  {
    tool: Tool.AmusementPark, label: '遊園地', key: 'x', group: 'leisure',
    icon: 'amusementPark',
  },

  { tool: Tool.Bulldoze, label: '撤去', key: '7', group: 'bulldoze', icon: 'bulldoze' },
];

export const TOOL_BY_KEY: Readonly<Record<string, Tool>> = Object.fromEntries(
  TOOL_LABELS.filter((t) => t.key !== '').map(({ tool, key }) => [key, tool]),
);

/** The two tools that pick stops on the map instead of building on a tile. */
export function lineToolFor(tool: Tool): LineMode | null {
  if (tool === Tool.Line) return LineMode.Rail;
  if (tool === Tool.BusLine) return LineMode.Road;
  return null;
}

/** Tools that paint continuously while the mouse is dragged. */
export function isDragTool(tool: Tool): boolean {
  return tool === Tool.Road || tool === Tool.Rail || tool === Tool.Bulldoze
    || tool === Tool.ElevatedRoad || tool === Tool.ElevatedRail
    || zoneOf(tool) !== null;
}

/** What one use of this tool costs the city. */
export function expenseOf(tool: Tool): Expense | null {
  switch (tool) {
    case Tool.Road:
      return Expense.Road;
    case Tool.Rail:
      return Expense.Rail;
    case Tool.ElevatedRoad:
      return Expense.ElevatedRoad;
    case Tool.ElevatedRail:
      return Expense.ElevatedRail;
    case Tool.Station:
      return Expense.Station;
    case Tool.BusStop:
      return Expense.BusStop;
    case Tool.Power:
      return Expense.PowerPlant;
    case Tool.School:
      return Expense.School;
    case Tool.FireStation:
      return Expense.FireStation;
    case Tool.PoliceStation:
      return Expense.PoliceStation;
    case Tool.Hospital:
      return Expense.Hospital;
    case Tool.Park:
      return Expense.Park;
    case Tool.Stadium:
      return Expense.Stadium;
    case Tool.AmusementPark:
      return Expense.AmusementPark;
    case Tool.Bulldoze:
      return Expense.Bulldoze;
    default:
      return zoneOf(tool) !== null ? Expense.Zone : null;
  }
}

/**
 * Which building each civic tool puts up.
 *
 * A table rather than a switch, so a new civic building -- the hospital, the
 * three leisure venues -- is one row here and one row in the building spec,
 * with nothing in between to forget.
 */
type ServiceTool =
  | Tool.School
  | Tool.FireStation
  | Tool.PoliceStation
  | Tool.Hospital
  | Tool.Park
  | Tool.Stadium
  | Tool.AmusementPark;

const SERVICE_BUILDINGS: Record<ServiceTool, BuildingType> = {
  [Tool.School]: BuildingType.School,
  [Tool.FireStation]: BuildingType.FireStation,
  [Tool.PoliceStation]: BuildingType.PoliceStation,
  [Tool.Hospital]: BuildingType.Hospital,
  [Tool.Park]: BuildingType.Park,
  [Tool.Stadium]: BuildingType.Stadium,
  [Tool.AmusementPark]: BuildingType.AmusementPark,
};

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
      if (!world.map.isWater(tile) && !world.railGradeAllows(tile, 0) && !world.map.isRail(tile)) {
        return { applied: false, message: '線路は1タイルにつき高低差1までしか登れません' };
      }
      return charged(world.placeRail(tile), economy, Expense.Rail);
    case Tool.ElevatedRoad:
      return charged(world.raiseRoad(tile), economy, Expense.ElevatedRoad);
    case Tool.ElevatedRail: {
      const result = charged(world.raiseRail(tile), economy, Expense.ElevatedRail);
      if (!result.applied && world.map.railRaise[tile] < MAX_RAISE) {
        return { applied: false, message: '前後の線路との高低差が大きすぎます' };
      }
      return result;
    }
    case Tool.Station: {
      const built = world.placeStation(tile) !== null;
      if (!built) return { applied: false, message: '駅は道路に接する空きタイルにしか置けません' };
      economy.charge(Expense.Station);
      return { applied: true };
    }
    case Tool.BusStop: {
      const built = world.placeBusStop(tile) !== null;
      if (!built) return { applied: false, message: 'バス停は道路に接する空きタイルに置けます' };
      economy.charge(Expense.BusStop);
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
    case Tool.School:
    case Tool.FireStation:
    case Tool.PoliceStation:
    case Tool.Hospital:
    case Tool.Park:
    case Tool.Stadium:
    case Tool.AmusementPark: {
      const built = world.placeService(tile, SERVICE_BUILDINGS[tool]) !== null;
      if (!built) return { applied: false, message: '道路に接する空きタイルにしか置けません' };
      economy.charge(expense as Expense);
      return { applied: true };
    }
    case Tool.Bulldoze:
      return charged(world.bulldoze(tile), economy, Expense.Bulldoze);
    case Tool.Select:
    case Tool.Line:
    case Tool.BusLine:
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
