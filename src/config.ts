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

/**
 * Below this fraction of its own free speed, a vehicle counts as not moving
 * for the purposes of the gridlock release above.
 *
 * It is a fraction rather than an absolute so a lorry and a car agree on what
 * "stopped" means. 2% of free speed is one tile every few hundred ticks: not
 * a slow crawl in traffic, but a vehicle that is going nowhere.
 */
export const GRIDLOCK_CRAWL_RATIO = 0.02;

/**
 * How far short of a tile boundary a vehicle holds at a red light or a closed
 * level crossing.
 *
 * It has to be more than nothing. A vehicle told to stop exactly *on* the
 * boundary converges onto it within a few ticks and is then, by definition,
 * inside the tile it was waiting to enter -- so a red light leaked a car every
 * few ticks. Holding a fiftieth of a tile short keeps the vehicle in its
 * approach, where the rule it is obeying still applies to it.
 */
export const STOP_LINE_SETBACK = 0.02;

/**
 * How far into an occupied junction a vehicle giving way may put its nose.
 *
 * Giving way is a slow-to-a-crawl rather than an absolute hold, because a
 * queue in this model can legitimately be standing *inside* a junction box:
 * refusing to enter until the box is clear turns a busy grid into a set of
 * all-way stops and the city seizes up. What matters is that the distance is
 * measured to the nose and is the same for every vehicle. Folding it into the
 * car-following gap instead made it depend on the length of the vehicle
 * asking, which let cars through and left lorries stalled at the same
 * junction for the rest of the day.
 */
export const GIVE_WAY_NOSE_IN = 0.1;


/** Trips shorter than this are walked instead of driven. */
export const WALK_DISTANCE_THRESHOLD = 12;

/**
 * The share of citizens who own a car.
 *
 * This is what makes public transport a real market rather than a curiosity.
 * A car in this model is door to door, four times walking speed, and free --
 * so a bus, which runs on the same road at the same speed and stops on the
 * way, can never beat one on time. It does not have to: a fifth of the city
 * has no car at all, and for them the choice is the bus or a very long walk.
 *
 * A fifth, rather than half, because the traffic model is the other thing
 * this number sets. Taking a quarter of the cars off the road would quietly
 * undo the congestion the whole simulation is built to produce.
 */
export const CAR_OWNERSHIP = 0.8;

// --- Lorries ---------------------------------------------------------------
// A lorry is a car with worse numbers -- but not *all* worse, and which ones
// took some measuring.
//
// It runs at the same free speed as a car. That is not laziness: there is one
// lane per direction and no overtaking in this model, so a lorry that cruises
// at 70% of car speed is not a nuisance, it is a permanent rolling roadblock.
// Thirty-six of them were enough to gridlock a city of a thousand that ran
// perfectly well without them -- at midnight, seven hundred people were still
// sitting in queues that had formed behind a lorry earlier in the day.
//
// What a lorry costs the city instead is space and time: it is half again as
// long, so it fills a junction faster and leaves a bigger gap in front of it,
// and it is slow to pull away and slow to stop. Distance still costs the
// supply chain, because the fleet is capped -- a supplier twice as far away
// consumes twice the lorry-hours to serve, and those hours come out of
// somebody else's delivery.

export const LORRY_FREE_SPEED = CAR_FREE_SPEED;
export const LORRY_ACCEL = 0.003;
export const LORRY_DECEL_COMFORT = 0.006;
export const LORRY_DECEL_MAX = 0.014;
export const LORRY_LENGTH = 0.45;
export const LORRY_MIN_GAP = 0.15;

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

/**
 * How much more the chain can make than the city consumes before growth stops
 * extending it. A margin, not a multiplier: at 1.25 a city keeps a quarter
 * more capacity than it needs, which absorbs a bad delivery day without
 * building an industry four times too big for its lorries to serve.
 */
export const CHAIN_HEADROOM = 1.25;

/**
 * People one shop serves. Six staff for thirty residents is generous, and the
 * number that matters is the other side of it: every shop is a shelf the
 * lorries have to keep filled, so a city with three times the shops it needs
 * spends its whole fleet topping them up.
 */
export const RESIDENTS_PER_SHOP = 30;

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

// --- Freight ---------------------------------------------------------------
// Goods move on lorries, and a lorry is a road vehicle like any other: it
// queues, it waits at red lights, it holds up the traffic behind it. These
// numbers are chosen for what that does to the city rather than for realism.
//
// One lorry's throughput is its load divided by its round trip. Over the
// 25-tile haul of a compact city that is 2 x 25 x 11.1 ticks of driving plus
// two dwells -- about 635 ticks, so 15 round trips a day, 180 units. A city of
// N people consumes N units a day and needs N of raw behind them, so 2N units
// of freight: about 6 lorries at 500 people and 22 at the 2000 cap. Visible on
// the roads, and nowhere near the cost of the citizens themselves.

/**
 * Units one lorry carries: five sim-hours of a factory's output, and half a
 * shop's shelf. Bigger loads mean fewer vehicles for the same goods, which is
 * the cheapest way to keep freight legible on the roads.
 */
export const LORRY_CAPACITY = 20;

/** Ticks spent at each dock loading or unloading. About 6 sim minutes. */
export const LORRY_DWELL_TICKS = 40;

/** Concurrent lorries one supplier can run. Two is one spare over its output. */
export const LORRIES_PER_BUILDING = 2;

/**
 * Fleet ceiling.
 *
 * A city of 2000 moves 4000 units a day (its own consumption, plus the raw
 * behind it) in 12-unit loads over a 25-tile haul: about 330 round trips, and
 * a lorry manages 15 a day. Fifteen lorries, then, and this is twice that.
 *
 * The cap has to be tight, because the failure it prevents is a feedback
 * loop rather than a memory bill: slow deliveries look like unmet demand,
 * unmet demand puts more lorries on the road, and more lorries make the
 * deliveries slower. Left at 120 the fleet gridlocked itself and the chain
 * starved with a hundred lorries standing in a queue.
 */
export const MAX_LORRIES = 28;

/**
 * Four dispatch rounds an hour, a handful of orders each. The throttle
 * matters as much as the cap: filling every shop's shelves at once is a
 * one-off spike far larger than the daily flow, and without a limit the fleet
 * would size itself to the spike.
 */
export const FREIGHT_INTERVAL_MINUTES = 15;
export const FREIGHT_DISPATCHES_PER_ROUND = 12;

/** Nearest suppliers considered per order, before the road route is checked. */
export const FREIGHT_SUPPLIER_CANDIDATES = 8;

/**
 * How full a consumer is topped up to, leaving room for the load already on
 * its way.
 *
 * Kept high for the shops in particular: real demand arrives in one evening
 * lump rather than smoothly through the day, so a shelf that is merely
 * adequate at noon is bare by eight and the shoppers who walked there go home
 * empty.
 */
export const FREIGHT_TARGET_FILL = 0.85;

/** A part-laden lorry is not worth the lane it occupies. */
export const FREIGHT_MIN_LOAD = 5;

/**
 * How far a supplier can be, measured in ticks of driving rather than tiles.
 *
 * This replaces the old SUPPLY_RANGE_TILES. Distance in tiles could never
 * express the thing that actually matters -- a jammed arterial shortens the
 * catchment of every factory behind it, and a quiet ring road lengthens it.
 * A supplier a lorry cannot reach and return from within a working day is not
 * a supplier.
 */
export const MAX_DELIVERY_TICKS = 1400;

/** How long a lorry with no route waits before trying again. */
export const FREIGHT_RETRY_TICKS = 300;

/** After this long with nowhere to go, a laden lorry gives up and goes home. */
export const FREIGHT_ABANDON_TICKS = 2400;

// --- Supply chain ----------------------------------------------------------

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
  // A bus stop is a pole and a shelter: cheap enough to put one on every
  // other block, which is the density the walk radius assumes.
  busStop: 900,
  school: 30_000,
  fireStation: 26_000,
  policeStation: 24_000,
  hospital: 34_000,
  // Leisure is priced by how far people will travel for it. A park is the
  // cheapest civic building in the game on purpose -- it is the one answer to
  // a miserable district that a broke city can still afford -- and the
  // fairground costs more than a power station, because it draws the whole
  // city across town and has to be a decision.
  park: 3_500,
  stadium: 45_000,
  amusementPark: 90_000,
  // A viaduct is the expensive answer to a cheap problem, and it has to be:
  // at fifteen times a road tile, taking a road over the railway is a
  // deliberate purchase rather than something to do everywhere.
  elevatedRoad: 700,
  elevatedRail: 1_500,
} as const;

/**
 * What one vehicle costs the city per day, by mode.
 *
 * Rolling stock was free until the lines window put an 増便 button in front of
 * the player, at which point "should this line run more?" had exactly one
 * answer. A train is the most expensive thing the city can add without
 * building anything; a bus is a fraction of it, which is the same argument
 * the two modes make everywhere else.
 */
export const UPKEEP_PER_TRAIN = 400;
export const UPKEEP_PER_BUS = 180;

export const UPKEEP_PER_ROAD_TILE = 0.5;
export const UPKEEP_PER_RAIL_TILE = 1.5;
/** A structure held up in the air costs more to keep than one on the ground. */
export const UPKEEP_PER_RAISED_TILE = 2;

export const LOAN_TRANCHE = 50_000;
export const MAX_DEBT = 400_000;
export const DEBT_INTEREST_PER_DAY = 0.004;
/** Unauthorised borrowing costs more than the arranged kind. */
export const OVERDRAFT_INTEREST_PER_DAY = 0.02;

export const TAX_RATE_LIMITS: readonly [number, number] = [0, 0.3];

/** The books are closed once a sim day, at midnight. */
export const TAX_DAY_MINUTE = 0;

// --- Shopping --------------------------------------------------------------
// The last leg of the supply chain is a trip like any other: somebody walks or
// drives to a shop, buys, and comes home. These numbers decide how much
// traffic that is worth. A basket of three days means shopping adds about a
// sixth of the trips commuting does -- enough to see on the roads and in the
// tax take, not enough to double the cost of the whole simulation.

/** Days of groceries one trip brings home. */
export const SHOPPING_BASKET = 3;

/** New arrivals turn up with a cupboard half full, so nobody shops on day one. */
export const STARTING_PANTRY = 1.5;

/** Go with a day still in hand rather than when bare: it leaves room to fail. */
export const SHOPPING_TRIGGER = 1.0;

/** Only head for a shop holding this many baskets, so shoppers spread out. */
export const SHOP_HEADROOM = 3;

/** Shops are worth walking to; beyond this the trip is not worth making. */
export const SHOP_SEARCH_RADIUS = 40;
export const SHOP_CANDIDATES = 6;

/** Early evening, spread wider than the commute: shopping has no start time. */
export const SHOPPING_MINUTE = 18 * 60 + 30;
export const SHOPPING_JITTER_MINUTES = 150;

/**
 * How long the shopping mood lasts, against the commute's 30 minutes.
 *
 * A half-hour window is right for a job you have to be at; for shopping it
 * quietly means most people never go, because they are still on the way home
 * through the whole of it and the chance does not come round again until
 * tomorrow.
 */
export const SHOPPING_WINDOW_MINUTES = 240;

/** Nobody shops in the small hours, however empty the cupboard is. */
export const SHOP_OPEN_MINUTE = 8 * 60;
export const SHOP_CLOSE_MINUTE = 22 * 60;

/** Time spent in the shop. About 9 sim minutes. */
export const SHOPPING_DWELL_TICKS = 60;

/** How long somebody gives up for after finding the shelves bare: 3 hours. */
export const SHOPPING_RETRY_TICKS = 1200;

// --- Leisure ---------------------------------------------------------------
// Where people go when they are neither at work nor at the shops.
//
// Modelled as a second appetite alongside the pantry, and for the same reason:
// "the city has three parks" is a number in a report, while "this household
// has not been anywhere in four days" is somebody who gets in the car on
// Sunday afternoon. Recreation is therefore a stock that drains and is
// refilled by an actual trip, which is what puts leisure traffic on the roads
// at a different hour from the commute.

/** Days of recreation a full outing is worth, and what everyone starts with. */
export const LEISURE_VISIT = 3;
export const STARTING_LEISURE = 1.5;

/** Below this many days in hand, an outing is worth making. */
export const LEISURE_TRIGGER = 1.0;

/** How fast the stock drains. A full visit lasts about three sim days. */
export const LEISURE_DRAIN_PER_HOUR = 1 / 24;

/**
 * How far somebody will look for somewhere to go, and how many candidates
 * they actually weigh up.
 *
 * Wider than the shopping radius: the whole point of a stadium is that it is
 * worth crossing town for, and a search that stopped at the next district
 * would make the expensive venues indistinguishable from a pocket park.
 */
export const LEISURE_SEARCH_RADIUS = 70;
export const LEISURE_CANDIDATES = 8;

/**
 * What one tile of distance is worth against a venue's draw.
 *
 * The choice is `draw / (1 + distance / LEISURE_DISTANCE_BIAS)`, so at the
 * bias distance a venue has to be twice as good to be worth the extra
 * journey. Twenty tiles is about a district: near enough that the local park
 * wins for a quick outing, far enough that the fairground still pulls people
 * from across the river.
 */
export const LEISURE_DISTANCE_BIAS = 20;

/** How long a visit lasts before setting off home. */
export const LEISURE_DWELL_TICKS = 220;

/** After a wasted trip, how long before trying again. */
export const LEISURE_RETRY_TICKS = 1400;

/** When people prefer to go out, and how widely that is spread. */
export const LEISURE_MINUTE = 14 * 60;
export const LEISURE_JITTER_MINUTES = 180;
export const LEISURE_WINDOW_MINUTES = 240;

/** Venues are open during the day only; nobody sets off for a closed park. */
export const LEISURE_OPEN_MINUTE = 8 * 60;
export const LEISURE_CLOSE_MINUTE = 20 * 60;

/**
 * How many sittings a venue takes between opening and closing.
 *
 * Its daily limit is `leisureCapacity(type)` times this, so a venue's size and
 * how long its day is are two numbers rather than one.
 *
 * A venue is not consumed the way a shop's stock is -- a park does not run out
 * of park -- but a fairground with the whole city inside it is not a day out
 * either. Crowding is measured against the daily visit count so that a single
 * stadium cannot serve a city of two thousand on its own.
 */
export const LEISURE_VISITS_PER_CAPACITY = 6;

/**
 * Each citizen takes one day off a week, decided by their seed.
 *
 * Staggered rather than a shared weekend, and that is a deliberate trade. A
 * city-wide Saturday would empty every workplace on the same day and make the
 * economy lurch in a seven-day cycle that says nothing about how the city is
 * built; a seventh of the population resting on any given day gives the same
 * thing worth having -- daytime leisure trips, a different traffic pattern --
 * with the city still running.
 */
export const REST_DAYS_PER_WEEK = 7;

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

/**
 * What a park is worth to the ground around it, and how far that carries.
 *
 * Deliberately the strongest per-tile amenity in the game, over a small
 * radius. That shape is the decision the tool is for: a park cannot rescue a
 * district, but it can rescue a block -- so parks get placed *between* the
 * housing and whatever is spoiling it, rather than sprinkled at random.
 */
export const PARK_AMENITY = 16;
export const PARK_REACH = 7;
/** The big venues are amenities too, over a wider area and worth less a tile. */
export const VENUE_AMENITY = 10;
export const VENUE_REACH = 12;

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

// --- Buses -----------------------------------------------------------------
// A bus is the other half of the transit answer, and it is deliberately the
// *worse* one on paper: it runs on the same roads as everybody else, so it
// queues in the same jam, and it carries half a train. What it has instead is
// that it needs no track and its stops are cheap, so a bus line can be drawn
// where a railway would never pay for itself -- and when the corridor it runs
// on congests, the player watches their own bus sit in their own traffic,
// which is the argument for building the railway.
//
// The numbers below put the break-even where that trade is interesting: over
// a free-flowing 30-tile corridor the bus is about as quick as driving (it
// stops, the car does not), and it wins outright once the road is busy,
// because a full bus is 30 people who are not each driving a car.

export const BUS_FREE_SPEED = CAR_FREE_SPEED;
export const BUS_ACCEL = 0.0035;
export const BUS_DECEL_COMFORT = 0.007;
export const BUS_DECEL_MAX = 0.016;
/** Longer than a car, shorter than a lorry: it fills a junction in between. */
export const BUS_LENGTH = 0.4;
export const BUS_MIN_GAP = 0.15;

/** Half a train. Two full buses a minute is a busy urban route. */
export const BUS_CAPACITY = 30;

/** Ticks at a stop. Shorter than a train's: fewer doors, fewer people. */
export const BUS_DWELL_TICKS = 14;

/** Buses per route. More buses is a shorter wait, and more of them in the jam. */
export const BUSES_PER_LINE = 3;

/**
 * How far somebody will walk to a bus stop, in tiles.
 *
 * Deliberately half the station figure. Bus stops are cheap and are meant to
 * be dense: if people walked as far to a stop as to a station there would be
 * no reason to place more than four of them, and the whole texture of a bus
 * network -- a stop every few blocks -- would never appear.
 */
export const BUS_STOP_WALK_RADIUS = 7;

// --- Civic services --------------------------------------------------------
// Schools, fire stations and police stations are the first buildings the city
// puts up for its residents rather than for its economy. Each one answers a
// different question, and each one is deliberately modelled through a
// different mechanism, because that is what the three things actually are:
//
//   school  -- a catchment. Can children get there by road at all?
//   fire    -- a response. How long does an engine take to arrive?
//   police  -- a field. How safe does this neighbourhood feel?
//
// Making all three "a radius that adds happiness" would have been half the
// code and none of the game.

/**
 * How far each service reaches along the road network, in tiles.
 *
 * Measured over roads rather than as the crow flies, so a school on the far
 * bank of the river serves nobody until somebody builds a bridge -- which is
 * the same rule the power grid already follows, and for the same reason: what
 * matters is whether the thing can actually be reached.
 */
export const SCHOOL_REACH_TILES = 24;
export const FIRE_REACH_TILES = 34;
/**
 * A hospital reaches further than a school and less far than a fire brigade.
 *
 * It is the same road flood as the other two, and the number says what the
 * building is: people will travel further to a hospital than children walk to
 * school, but a district it cannot reach along a road is a district whose
 * ambulances do not arrive -- which is the fire brigade's problem, and is why
 * it does not out-reach it.
 */
export const HOSPITAL_REACH_TILES = 28;

/** Civic coverage is re-solved on the same cadence as the power grid. */
export const SERVICES_INTERVAL_MINUTES = 30;

/**
 * Education, 0..100, and what it is worth.
 *
 * A resident within reach of a working school gains education steadily; one
 * without keeps whatever they arrived with. It pays off in wages -- an
 * educated workforce produces more per job, and the city taxes the difference
 * -- which makes a school an investment with a payback period rather than an
 * ornament. At 0.8 a point an hour a new arrival reaches full education in
 * about four sim days, so the effect is visible within a session.
 */
export const STARTING_EDUCATION = 20;
export const EDUCATION_PER_HOUR = 0.8;
/** Wages at full education, as a multiple of the untaught rate. */
export const EDUCATION_WAGE_BONUS = 0.5;

// --- Health ----------------------------------------------------------------
// Health is education's opposite number and is deliberately *not* modelled the
// same way. Education only ever goes up -- what you were taught you keep --
// while health is a running balance between where somebody lives and whether a
// hospital can reach them. That asymmetry is the point: a school built once
// keeps paying, a hospital has to keep being reachable.

export const STARTING_HEALTH = 70;

/** Where health settles with a hospital in reach, and without one. */
export const HEALTH_WITH_HOSPITAL = 92;
export const HEALTH_WITHOUT_HOSPITAL = 58;

/**
 * What a fully noisy, fully unsafe neighbourhood takes off that target.
 *
 * Noise stands in for the whole environment here -- the arterial road, the
 * factory next door -- because it is the field the player already understands
 * and already acts on.
 */
export const HEALTH_NOISE_PENALTY = 22;
export const HEALTH_CRIME_PENALTY = 10;

/** How fast health moves towards its target, per sim hour. */
export const HEALTH_RECOVERY = 0.18;

// --- Crime -----------------------------------------------------------------
// Crime is a field like noise: a property of a neighbourhood rather than of a
// building. It rises with density and with cheap land, falls where a police
// station is within reach, and lands on happiness and on land value -- so a
// district the player has let rot gets visibly worse to live in, and the fix
// is a station and the land value that follows it.

/** Crime pressure one resident and one shop put on their surroundings. */
export const CRIME_PER_RESIDENT = 2.2;
export const CRIME_PER_SHOP = 12;
/** How far that pressure spreads, in tiles. */
export const CRIME_SPREAD = 6;

/**
 * Extra crime on land nobody wants, at land value 0, falling to none at 60.
 * Poverty is a cause the player can act on: raise the land value, and the
 * crime that came with it goes away.
 */
export const CRIME_FROM_POVERTY = 30;

/** What one police station takes off the crime score, and how far it reaches. */
export const POLICE_RELIEF = 55;
export const POLICE_REACH = 18;

/** How fast the crime field follows the city, like the noise field. */
export const CRIME_SMOOTHING = 0.2;

// --- Emergencies -----------------------------------------------------------
// Fires and crimes are the first events in this simulation that are *against*
// the player, and they are deliberately answered by road vehicles rather than
// by a coverage percentage. An engine that has to cross the city through the
// jam the player built is the point: response time is emergent, and a fire
// station on the wrong side of a congested corridor is a station that does not
// work, exactly as a factory there is a factory that does not deliver.

/** Emergency vehicles kept at each station. */
export const UNITS_PER_STATION = 2;

/**
 * Chance per building per sim-day of a fire starting, before the type
 * multiplier. About one fire a day in a town of 250 buildings: often enough
 * that a city without a fire brigade visibly loses buildings, rare enough
 * that one is an event rather than a chore.
 */
export const FIRE_CHANCE_PER_DAY = 0.004;

/** Industry burns more often than housing; a power station most of all. */
export const FIRE_RISK_INDUSTRIAL = 4;
export const FIRE_RISK_POWER = 6;

/** A station within reach also inspects: fires there start less often. */
export const FIRE_INSPECTION_RELIEF = 0.6;

/**
 * How long a building burns before it is lost, in ticks. 900 ticks is a bit
 * over two sim hours -- long enough to watch an engine fight its way across
 * town, short enough that ignoring the alarm costs the building.
 */
export const FIRE_BURN_TICKS = 900;

/** Ticks an engine spends on scene putting a fire out. */
export const FIRE_WORK_TICKS = 120;

/**
 * Chance per sim-day that a building at crime 100 is hit. Scaled by the crime
 * field, so a well-policed district is quiet and a neglected one is not.
 */
export const CRIME_CHANCE_PER_DAY = 0.06;

/** How long a crime stands unanswered before it simply succeeds. */
export const CRIME_OPEN_TICKS = 600;

/** Ticks a patrol car spends on scene. */
export const CRIME_WORK_TICKS = 90;

/** Goods a burglary takes from a shop that nobody answered for. */
export const CRIME_THEFT_UNITS = 12;

/** Crime added to the neighbourhood by an offence that went unanswered. */
export const CRIME_UNSOLVED_PENALTY = 14;

/** How often incidents are rolled for, and units re-dispatched. */
export const EMERGENCY_INTERVAL_MINUTES = 30;

/** How long a unit with no route waits before trying again. */
export const EMERGENCY_RETRY_TICKS = 200;

// --- Ordinances ------------------------------------------------------------
// A handful of city-wide policies the player switches on and pays for daily.
//
// Every one of them is a *multiplier on a system that already exists* rather
// than a new mechanism: the fare subsidy moves the number the mode choice is
// already compared against, the energy by-law scales the draw the grid already
// sums, the patrols add to the relief a police station already spreads, and
// the greening by-law scales the amenity a park already emits. An ordinance
// that needed its own subsystem would be a second, invisible game running
// beside the visible one.

/** How much more willing a subsidised rider is to leave the car at home. */
export const ORDINANCE_TRANSIT_PREFERENCE = 1.25;
/** Paid per rider carried yesterday: a subsidy costs what it is used for. */
export const ORDINANCE_TRANSIT_COST_PER_RIDER = 26;

/** What the energy by-law takes off every building's draw, and its daily cost. */
export const ORDINANCE_ENERGY_SAVING = 0.15;
export const ORDINANCE_ENERGY_COST_PER_BUILDING = 14;

/** Extra crime relief around every working police station, and its cost. */
export const ORDINANCE_PATROL_RELIEF = 22;
export const ORDINANCE_PATROL_COST_PER_RESIDENT = 6;

/** What the greening by-law is worth to a park, and what it costs per park. */
export const ORDINANCE_GREENING_AMENITY = 1.5;
export const ORDINANCE_GREENING_DRAW = 1.25;
export const ORDINANCE_GREENING_COST_PER_PARK = 220;

/** Free clinics: where health settles with one, and the cost per resident. */
export const ORDINANCE_HEALTH_BONUS = 10;
export const ORDINANCE_HEALTH_COST_PER_RESIDENT = 8;

// --- Terrain height --------------------------------------------------------
// The map stops being a sheet of paper here. Every tile has a height in whole
// levels, and three things read it: what a slope does to speed, where a
// railway may be laid at all, and what a view is worth.
//
// Levels rather than metres, for the same reason the sim has no metres
// anywhere else: what matters is the *step* between two neighbouring tiles,
// because that is what a vehicle climbs and what a track cannot.

export const MAX_TERRAIN_HEIGHT = 6;

/**
 * The steepest step a railway may climb between two tiles.
 *
 * One level, against a road's none: this asymmetry is the whole point of
 * having heights at all. A road can go up anything (badly, slowly); a railway
 * cannot, so it has to follow the contours, take the long way round, or be
 * carried over the ground on a viaduct -- which is exactly the decision a
 * railway engineer makes and the one this feature exists to offer.
 */
export const MAX_RAIL_STEP = 1;

/**
 * How much of its free speed a vehicle loses per level climbed, before the
 * per-vehicle multiplier below.
 *
 * Set by what it does to a route rather than by physics: at 0.22 a car on the
 * steepest ordinary hill (two levels in one tile) runs at a bit over half
 * speed, so a hilly detour is worth taking and a hill in the middle of a
 * commute is worth routing around -- but nothing is ever impassable.
 */
export const GRADE_SPEED_PENALTY = 0.22;

/** Nothing crawls to a stop on a hill; this is the floor on the penalty. */
export const MIN_GRADE_SPEED_RATIO = 0.3;

/**
 * How uneven the ground under a zone may be, in levels, counting the tile and
 * its four neighbours.
 *
 * Buildings need a level plot. Keeping it at one level means gentle slopes
 * build normally and an escarpment stays green, which is what makes a hillside
 * a piece of landscape rather than more of the same city.
 */
export const MAX_BUILD_RELIEF = 1;

// --- Elevated structures ---------------------------------------------------
// A road or a track can be carried above the ground it stands on. That single
// number -- how far above -- answers three separate things the city needs:
//
//   * a road over a railway is not a level crossing, so the barrier never
//     comes down and the queue never forms;
//   * a viaduct over water is a bridge, which is the only way across the
//     river this city has ever had;
//   * and a railway can hold its own gradient across ground that rises and
//     falls under it, which is what makes MAX_RAIL_STEP survivable.

/** How far above its own ground a structure may be carried. */
export const MAX_RAISE = 3;

/**
 * The height difference at which two structures stop being the same place.
 *
 * One level. Anything sharing a tile at the same height is a level crossing;
 * a single level apart and they simply pass, which is the whole of grade
 * separation in this model.
 */
export const CLEARANCE = 1;

/** How much of a tile one level of elevation is drawn as, for the renderer. */
export const RAISE_DRAW_HEIGHT = 0.22;
