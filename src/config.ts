/**
 * All tuning constants live here, together with the reasoning behind them.
 *
 * ## Why the tick is the only clock
 *
 * Physically-correct vehicle speeds, a short in-game day, and a watchable
 * on-screen pace cannot coexist. They are tied by one identity:
 *
 *     D = V * L * C / 1440
 *
 *     D = trip distance      (tiles)
 *     V = on-screen speed    (tiles per real second)
 *     L = day length         (real seconds)
 *     C = trip duration      (sim minutes)
 *
 * Plugging in real units (8 m tiles, 40 km/h) gives 83 tiles per sim-minute,
 * which would teleport cars across the map and make tile-based traffic
 * meaningless. So we do not model km/h at all: the tick is the single time
 * base, and the clock, the speeds and the ETA readout are all derived from it.
 * The result is not physically accurate, but it is self-consistent -- an ETA
 * shown in the inspector is computed from the same numbers the sim runs on.
 */

/** Simulation ticks per real second at speed x1. */
export const TICK_HZ = 16;

/** How much sim time one tick advances. 16 * 9 = 144x wall-clock. */
export const SIM_SECONDS_PER_TICK = 9;

/** 86400 / 9 = 9600 ticks per day = 600 real seconds = 10 minutes at x1. */
export const TICKS_PER_DAY = 86_400 / SIM_SECONDS_PER_TICK;

/** Pause, observe-a-single-citizen, normal, fast, very fast. */
export const SPEED_MULTIPLIERS = [0, 0.25, 1, 3, 10] as const;
export const DEFAULT_SPEED_INDEX = 2;

/** Upper bound on ticks per frame, so a slow frame cannot spiral. */
export const MAX_TICKS_PER_FRAME = 8;

// --- World -----------------------------------------------------------------

export const MAP_SIZE = 128;

// Deliberately absent: a tiles-to-metres constant. Attaching one makes the
// inspector claim things the model does not support -- a 7-tile walk is 33 sim
// minutes, which reads fine as "seven blocks" and absurd as "56 metres". The
// sim is self-consistent in ticks and tiles; it does not model metres, so it
// does not display them.

// --- Movement --------------------------------------------------------------
// Speeds are tiles per tick. At 16 ticks/s, 0.125 tiles/tick reads as
// 2.0 tiles per real second on screen -- calm enough to follow one car.
// A 40-tile commute is then 320 ticks: 20 real seconds, 48 sim minutes.
// Staying well under 0.5 tiles/tick guarantees no tile is ever stepped over,
// which is what keeps the occupancy bookkeeping (and thus traffic) honest.

export const CAR_FREE_SPEED = 0.125;
export const WALK_SPEED = 0.032;

/** 0 -> full speed in ~24 ticks (1.5 real seconds at x1). */
export const CAR_ACCEL = 0.005;

/** Normal braking. Stopping distance v^2/(2a) is about one tile. */
export const CAR_DECEL_COMFORT = 0.008;

/** Emergency braking, used as the per-tick clamp on deceleration. */
export const CAR_DECEL_MAX = 0.02;

export const CAR_LENGTH = 0.25;
export const CAR_MIN_GAP = 0.15;

/** Stopped cars per tile: 1 / (CAR_LENGTH + CAR_MIN_GAP) ~= 2.5. */
export const TILE_CAR_CAPACITY = 3;

/**
 * A car held at a full tile for this many ticks is let in anyway. Without
 * this escape hatch a ring of mutually-blocking intersections deadlocks
 * permanently; with it, gridlock drains slowly instead of freezing.
 */
export const GRIDLOCK_RELEASE_TICKS = 60;

/** Trips shorter than this are walked instead of driven. */
export const WALK_DISTANCE_THRESHOLD = 12;

// --- Lorries ---------------------------------------------------------------
// A lorry is a car with worse numbers, and each one is chosen for the effect
// it has on the city rather than on any real vehicle. Slower and lower-geared
// so distance costs the supply chain something; longer so a queue of them is
// visibly a queue of lorries; a gentler emergency stop for the same reason a
// train has one -- a laden lorry does not stop like a hatchback.

export const LORRY_FREE_SPEED = 0.09;
export const LORRY_ACCEL = 0.003;
export const LORRY_DECEL_COMFORT = 0.006;
export const LORRY_DECEL_MAX = 0.014;
export const LORRY_LENGTH = 0.6;
export const LORRY_MIN_GAP = 0.2;

// --- Rail ------------------------------------------------------------------
// Whether a line is worth building comes out of one inequality. The ride saves
// D * (1/CAR - 1/TRAIN) ticks over driving, and costs the walk to and from the
// platforms plus half a headway. With the values below:
//
//     saved  = D * (8 - 2.5)          = 5.5 D
//     cost   = walkTiles / WALK_SPEED + (2D / TRAIN) / TRAINS / 2
//
// so a line pays off past roughly 50 tiles with a long walk at each end, and
// past about 25 with stations sitting right on top of the housing. That is the
// intended shape: **station siting is the interesting decision**, exactly as it
// is in the games this borrows from. Both levers here were raised once after
// measuring the original numbers, which put the break-even beyond the width of
// the map and left every line empty.
//
// 0.4 tiles/tick is 6.4 tiles per real second -- visibly quicker than traffic,
// and still under the 0.5 ceiling that keeps tile stepping exact.

export const TRAIN_FREE_SPEED = 0.4;
export const TRAIN_ACCEL = 0.004;
export const TRAIN_DECEL_COMFORT = 0.006;

/** Trains are long; this is the gap they keep from the train ahead. */
export const TRAIN_LENGTH = 1.5;
export const TRAIN_MIN_GAP = 1;

export const TRAIN_CAPACITY = 60;

/** Ticks held at a platform for boarding: about 3 sim minutes. */
export const TRAIN_DWELL_TICKS = 20;

/** More trains is a shorter headway, which is the other half of the sum. */
export const TRAINS_PER_LINE = 4;

/**
 * How far ahead of a train a level crossing closes to road traffic. Long
 * enough that a car braking comfortably can always stop short of the rails.
 */
export const CROSSING_WARN_TILES = 8;

/** How far a citizen will walk to reach a station, in tiles. */
export const STATION_WALK_RADIUS = 14;

/**
 * Transit has to beat driving by this factor before a citizen picks it, which
 * stands in for the friction of changing mode. At 1.0 people would flip to the
 * train over a one-tick difference.
 */
export const TRANSIT_PREFERENCE = 0.95;

// --- Citizens --------------------------------------------------------------

/** Sim minutes past midnight. Jittered per citizen to spread the rush hour. */
export const WORK_START_MINUTE = 9 * 60;
export const WORK_END_MINUTE = 17 * 60;
export const SCHEDULE_JITTER_MINUTES = 60;

/** Population ceiling, matching the ~2000 citizens the design targets. */
export const MAX_POPULATION = 2000;

// --- Growth ----------------------------------------------------------------

/** Growth is evaluated once per sim hour (25 real seconds at x1). */
export const GROWTH_INTERVAL_MINUTES = 60;
export const BUILDINGS_PER_GROWTH_STEP = 3;

/**
 * The town keeps a standing surplus of vacant jobs. Without that buffer the
 * two sides settle into exact balance -- no vacancies, so nobody moves in;
 * nobody unemployed, so no new workplaces -- and the city stops dead a few
 * buildings in.
 */
export const JOB_SURPLUS_RATIO = 0.15;

/** Land value a tile needs before anyone will build a block of flats on it. */
export const HIGH_DENSITY_LAND_VALUE = 55;

/** Sim-hours a business survives with nothing to work with before closing. */
export const ABANDON_AFTER_HOURS = 72;

// --- Pathfinding -----------------------------------------------------------

/** Searches dispatched per tick; the rest queue for the next one. Without a
 *  cap the 8am departure spike would stall a frame. */
export const PATH_REQUESTS_PER_TICK = 64;
export const PATH_CACHE_SIZE = 4000;

// --- Traffic signals -------------------------------------------------------
// Only four-way (and T) junctions where two axes actually conflict get a
// signal; a corner has nothing to arbitrate. The cycle is deliberately short
// in ticks -- 48 ticks is 3 real seconds at x1, long enough to watch a queue
// build and discharge, short enough that a commute is not dominated by it.

export const SIGNAL_GREEN_TICKS = 48;

/** Everything red between phases, so the box clears before the cross flow. */
export const SIGNAL_ALL_RED_TICKS = 6;

export const SIGNAL_CYCLE_TICKS = 2 * (SIGNAL_GREEN_TICKS + SIGNAL_ALL_RED_TICKS);

// --- Rendering -------------------------------------------------------------

/**
 * How far off the centre of the road a vehicle is drawn, in tiles. Traffic
 * keeps left, so the two directions occupy visibly separate lanes -- which is
 * also exactly what the occupancy model already assumes (opposing traffic is
 * never counted as blocking).
 */
export const LANE_OFFSET = 0.2;

/** Pedestrians keep left too, but on the pavement rather than the lane. */
export const WALK_LANE_OFFSET = 0.34;

// --- Statistics ------------------------------------------------------------

/** Completed trips kept for the rolling averages shown in the stats panel. */
export const TRIP_HISTORY_SIZE = 300;

// --- Power -----------------------------------------------------------------

/**
 * One plant runs about 150 low-density homes, or 30 factories.
 *
 * Sized against its upkeep rather than against anything electrical: a city
 * should need a handful of plants, not dozens, because the interesting
 * decision is where to put a noisy one -- not clicking twelve of them.
 */
export const POWER_PLANT_OUTPUT = 600;

/** The grid is re-solved on this cadence; it only changes when the city does. */
export const POWER_INTERVAL_MINUTES = 30;

// --- Supply chain ----------------------------------------------------------

/**
 * How far goods will travel between two buildings on the same road network.
 * Beyond this the chain simply does not connect, which is what makes an
 * industrial estate on the far edge of the map a mistake rather than a detail.
 */
export const SUPPLY_RANGE_TILES = 90;

/**
 * Units a resident buys per day. This one number sets the size of the whole
 * chain: at 1.0 a thousand people need about ten factories behind their shops,
 * and ten farms or mines behind those.
 */
export const GOODS_PER_RESIDENT_PER_DAY = 1.0;

/** The chain, like growth, ticks once per sim hour. */
export const CHAIN_INTERVAL_MINUTES = 60;

// --- Money -----------------------------------------------------------------
// The numbers below were set by running a working city and reading the daily
// balance: a compact town that feeds its shops and does not over-build roads
// runs a small surplus, and one that sprawls does not. Construction is a
// one-off the player can save up for; upkeep is forever, which is what makes
// the size of the road network a decision rather than a free choice.

export const STARTING_FUNDS = 250_000;

export const BUILD_COSTS = {
  road: 45,
  rail: 120,
  zone: 25,
  station: 4_000,
  powerPlant: 22_000,
  bulldoze: 15,
} as const;

export const UPKEEP_PER_ROAD_TILE = 0.5;
export const UPKEEP_PER_RAIL_TILE = 1.5;

export const LOAN_TRANCHE = 50_000;
export const MAX_DEBT = 400_000;
export const DEBT_INTEREST_PER_DAY = 0.004;
/** Unauthorised borrowing costs more than the arranged kind. */
export const OVERDRAFT_INTEREST_PER_DAY = 0.02;

export const TAX_RATE_LIMITS: readonly [number, number] = [0, 0.3];

/** The books are closed once a sim day, at midnight. */
export const TAX_DAY_MINUTE = 0;

// --- Noise, land value, happiness -------------------------------------------

/**
 * Noise added per car-tick observed on a tile.
 *
 * Set by looking at what it does to land value rather than at anything
 * acoustic: a quiet residential street should barely register, while a jammed
 * arterial should be worth avoiding when siting housing. Too high and the
 * whole city is unliveable the moment it has traffic, which makes the field
 * useless as a thing to design around.
 */
export const TRAFFIC_NOISE_PER_CAR = 13;

/** How fast the noise field follows what is happening now. */
export const NOISE_SMOOTHING = 0.35;

/** Fields are rebuilt every sim hour: they are slow-moving by construction. */
export const FIELD_INTERVAL_MINUTES = 60;

/**
 * Commute time at which a citizen is thoroughly fed up, in sim minutes.
 * Anything under a third of this is a commute nobody complains about.
 */
export const COMMUTE_MISERY_MINUTES = 180;

/** Happiness below this, sustained, and a citizen leaves the city. */
export const UNHAPPY_THRESHOLD = 30;

/** Sim-hours of misery before someone actually packs up. */
export const PATIENCE_HOURS = 48;

/** Migration is evaluated once per sim hour, with growth. */
export const MIGRATION_INTERVAL_MINUTES = 60;

/**
 * People who move in per hour, at most, when the city is at its most
 * attractive. Scaled down by how happy the place actually is, so a mediocre
 * town grows slowly and a miserable one not at all.
 */
export const MOVE_IN_PER_HOUR = 26;
