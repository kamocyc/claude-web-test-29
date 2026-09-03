import {
  BUILD_COSTS,
  DEBT_INTEREST_PER_DAY,
  LOAN_TRANCHE,
  MAX_DEBT,
  OVERDRAFT_INTEREST_PER_DAY,
  STARTING_FUNDS,
  EDUCATION_WAGE_BONUS,
  TAX_RATE_LIMITS,
  UPKEEP_PER_RAIL_TILE,
  UPKEEP_PER_RAISED_TILE,
  UPKEEP_PER_ROAD_TILE,
} from '../config';
import { Industry } from '../core/types';
import { workforceEducation } from './education';
import { industryOf, isWorkplace, specFor } from '../world/buildings';
import type { World } from '../world/world';
import type { Policies } from './policies';

/** What the player can be charged for. */
export const enum Expense {
  Road = 'road',
  Rail = 'rail',
  Zone = 'zone',
  Station = 'station',
  PowerPlant = 'powerPlant',
  Bulldoze = 'bulldoze',
  BusStop = 'busStop',
  School = 'school',
  FireStation = 'fireStation',
  PoliceStation = 'policeStation',
  Hospital = 'hospital',
  Park = 'park',
  Stadium = 'stadium',
  AmusementPark = 'amusementPark',
  ElevatedRoad = 'elevatedRoad',
  ElevatedRail = 'elevatedRail',
}

/** Tax is levied per category, because that is the lever the player has. */
export interface TaxRates {
  residential: number;
  commercial: number;
  industrial: number;
  office: number;
}

/** One day's books, kept so the panel can show where the money went. */
export interface Ledger {
  residentialTax: number;
  commercialTax: number;
  industrialTax: number;
  officeTax: number;
  upkeep: number;
  interest: number;
  /** What the city's by-laws cost yesterday, all of them together. */
  ordinances: number;
}

export interface DayResult {
  income: number;
  expenses: number;
  net: number;
}

/**
 * The city's money.
 *
 * Two rules make this more than a counter. Construction is refused outright
 * when the balance will not cover it -- so the road network the player can
 * afford is the road network they get -- while upkeep is *not* refused: it is
 * taken whether or not the money is there, and an overdraft charges interest
 * and makes everybody miserable. That asymmetry is what turns a sprawling
 * road network into a decision rather than a free choice: laying it is a
 * one-off you can save up for, keeping it is forever.
 */
export class Economy {
  balance = STARTING_FUNDS;
  debt = 0;

  rates: TaxRates = {
    residential: 0.12,
    commercial: 0.12,
    industrial: 0.1,
    office: 0.1,
  };

  /** Yesterday's books, for the budget panel. */
  lastDay: DayResult = { income: 0, expenses: 0, net: 0 };
  breakdown: Ledger = {
    residentialTax: 0,
    commercialTax: 0,
    industrialTax: 0,
    officeTax: 0,
    upkeep: 0,
    interest: 0,
    ordinances: 0,
  };

  /** Total spent on construction since the city was founded. */
  spentOnBuilding = 0;

  costOf(expense: Expense, tiles = 1): number {
    return BUILD_COSTS[expense] * tiles;
  }

  canAfford(expense: Expense, tiles = 1): boolean {
    return this.balance >= this.costOf(expense, tiles);
  }

  /** Charge for construction. Returns false, and charges nothing, if broke. */
  charge(expense: Expense, tiles = 1): boolean {
    const cost = this.costOf(expense, tiles);
    if (this.balance < cost) return false;
    this.balance -= cost;
    this.spentOnBuilding += cost;
    return true;
  }

  setRate(category: keyof TaxRates, value: number): void {
    const [min, max] = TAX_RATE_LIMITS;
    this.rates[category] = Math.min(max, Math.max(min, Math.round(value * 100) / 100));
  }

  borrow(): boolean {
    if (this.debt + LOAN_TRANCHE > MAX_DEBT) return false;
    this.debt += LOAN_TRANCHE;
    this.balance += LOAN_TRANCHE;
    return true;
  }

  /** Pay back what the balance can cover, in whole tranches. */
  repay(): boolean {
    const amount = Math.min(this.debt, LOAN_TRANCHE);
    if (amount <= 0 || this.balance < amount) return false;
    this.debt -= amount;
    this.balance -= amount;
    return true;
  }

  /**
   * Close the day's books: collect tax, pay upkeep, service the debt.
   *
   * Tax is levied on what was actually produced, not on what exists. An
   * unpowered factory with no raw materials employs nobody usefully and pays
   * nothing, which is what makes a broken supply chain show up as a hole in
   * the budget rather than only as a number in an industry panel.
   */
  settleDay(world: World, policies?: Policies, ridersYesterday = 0): DayResult {
    const book: Ledger = {
      residentialTax: 0,
      commercialTax: 0,
      industrialTax: 0,
      officeTax: 0,
      upkeep: 0,
      interest: 0,
      ordinances: 0,
    };

    for (const b of world.buildings) {
      if (!b.alive) continue;
      const spec = specFor(b.type);

      if (isWorkplace(b.type)) {
        // Wages are per person actually employed, and are only paid where the
        // lights are on. Scaling them by staffing as well would count the same
        // shortfall twice, since the head count is already the head count.
        //
        // What an educated workforce is worth is folded in here rather than
        // anywhere else, because a wage is the only place education has ever
        // meant anything: a city that builds schools produces more per job
        // and taxes the difference, which is what pays the schools back.
        const skill = 1 + EDUCATION_WAGE_BONUS * (workforceEducation(world, b.occupants) / 100);
        const wages = b.powered ? spec.wagePerJob * b.occupants.length * skill : 0;
        switch (industryOf(b.type)) {
          case Industry.Retail:
            // Shops are taxed on turnover, so an empty shop pays nothing.
            book.commercialTax += b.soldToday * COMMERCIAL_MARGIN * this.rates.commercial;
            break;
          case Industry.Secondary:
          case Industry.Primary:
            book.industrialTax += wages * this.rates.industrial;
            break;
          case Industry.Tertiary:
            book.officeTax += wages * this.rates.office;
            break;
          default:
            break;
        }
        // Everybody with a job pays income tax where they live.
        book.residentialTax += wages * this.rates.residential;
      }
      b.soldToday = 0;
    }

    // A viaduct costs more to keep than the ground it replaced, and the bill
    // is per level: a road carried three storeys up is three times the
    // structure of one carried one.
    book.upkeep = world.infrastructureUpkeep
      + world.countTiles(world.map.road) * UPKEEP_PER_ROAD_TILE
      + world.countTiles(world.map.rail) * UPKEEP_PER_RAIL_TILE
      + (world.countTiles(world.map.roadRaise) + world.countTiles(world.map.railRaise))
        * UPKEEP_PER_RAISED_TILE;

    // The by-laws are billed like upkeep rather than refused like
    // construction: a city that cannot afford its own ordinances goes
    // overdrawn, which is the pressure that makes keeping one a decision.
    book.ordinances = policies ? policies.settleDay(world, ridersYesterday) : 0;

    book.interest = this.debt * DEBT_INTEREST_PER_DAY
      + (this.balance < 0 ? -this.balance * OVERDRAFT_INTEREST_PER_DAY : 0);

    const income = book.residentialTax + book.commercialTax + book.industrialTax + book.officeTax;
    const expenses = book.upkeep + book.interest + book.ordinances;
    this.balance += income - expenses;

    this.breakdown = book;
    this.lastDay = { income, expenses, net: income - expenses };
    return this.lastDay;
  }

  /** True when the city is spending money it does not have. */
  get inOverdraft(): boolean {
    return this.balance < 0;
  }

  restore(state: { balance: number; debt: number; rates: TaxRates; spentOnBuilding: number }): void {
    this.balance = state.balance;
    this.debt = state.debt;
    this.rates = { ...state.rates };
    this.spentOnBuilding = state.spentOnBuilding;
  }
}

/**
 * What a shop keeps out of a unit sold. Taxing turnover directly would make
 * commercial rates behave completely differently from the others, which are on
 * wages; the margin puts them on the same footing.
 */
const COMMERCIAL_MARGIN = 14;
