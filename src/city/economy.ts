/**
 * The city's money.
 *
 * Construction is charged from the one number the engine already keeps: the
 * cost of the network it has derived. Lay a road and that figure goes up by
 * exactly what the road cost, so the treasury does not need its own price
 * list, and the price the tool quotes in the status bar cannot drift from the
 * price the player is charged. Taking a road up is not a refund -- the money
 * was spent -- so only rises are charged.
 *
 * Upkeep is *not* refused when the balance will not cover it, and that
 * asymmetry is the whole game of it: what you can afford to lay is a decision
 * you make once, and what you can afford to keep is a decision you make every
 * day.
 */

export interface DayResult {
  income: number;
  expenses: number;
  net: number;
}

/** What a filled job is worth to the city in tax, per sim day. */
export const TAX_PER_JOB = 34;
/** ...and what a household pays. */
export const TAX_PER_RESIDENT = 12;

export class Treasury {
  balance: number;
  /** Total spent on construction since the city was founded. */
  spent = 0;
  lastDay: DayResult = { income: 0, expenses: 0, net: 0 };

  /** The network cost figure the last charge was measured against. */
  private lastNetworkCost = 0;

  constructor(startingFunds = 400_000) {
    this.balance = startingFunds;
  }

  /** True when the city could pay for something costing `amount`. */
  canAfford(amount: number): boolean {
    return this.balance >= amount;
  }

  /**
   * Charge for whatever has been laid since this was last called.
   *
   * Returns what was taken. The first call after a load or a new game only
   * records the baseline -- a city is not charged for the town it starts with.
   */
  chargeNetwork(networkCost: number, baselineOnly = false): number {
    const delta = networkCost - this.lastNetworkCost;
    this.lastNetworkCost = networkCost;
    if (baselineOnly || delta <= 0) return 0;
    this.balance -= delta;
    this.spent += delta;
    return delta;
  }

  /** Close the day's books. */
  settleDay(input: { employed: number; population: number; upkeep: number }): DayResult {
    const income = input.employed * TAX_PER_JOB + input.population * TAX_PER_RESIDENT;
    const expenses = input.upkeep;
    this.balance += income - expenses;
    this.lastDay = { income, expenses, net: income - expenses };
    return this.lastDay;
  }

  get inOverdraft(): boolean {
    return this.balance < 0;
  }

  capture(): TreasurySave {
    return {
      balance: this.balance,
      spent: this.spent,
      lastDay: { ...this.lastDay },
      lastNetworkCost: this.lastNetworkCost,
    };
  }

  adopt(save: TreasurySave): void {
    this.balance = save.balance;
    this.spent = save.spent;
    this.lastDay = { ...save.lastDay };
    this.lastNetworkCost = save.lastNetworkCost;
  }
}

export interface TreasurySave {
  balance: number;
  spent: number;
  lastDay: DayResult;
  /**
   * The network-cost figure the books were last squared against.
   *
   * Saved because it is a *watermark*, not a total: without it a loaded city
   * would be charged all over again for every road it had ever laid.
   */
  lastNetworkCost: number;
}
