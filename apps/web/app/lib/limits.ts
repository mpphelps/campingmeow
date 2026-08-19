/**
 * Caps on how much ReserveCalifornia work one user action can create.
 *
 * The scanner makes 9 grid calls per campground (21 days per call, 180-day
 * window) at ~1 request/second, so a campground costs roughly 10 seconds of API
 * budget. Only the scanner spends that budget — searches read the database — so
 * these caps are really about what a *watch* commits us to, forever.
 */

/**
 * Campgrounds one availability search may cover. Search reads our database and
 * never calls ReserveCalifornia, so this no longer rations API budget — it just
 * bounds one query and one page of results. Kept generous.
 */
export const MAX_SEARCH_FACILITIES = 50;

/**
 * Campgrounds one watch may cover. Watches are swept hourly, so each one costs
 * its campground count × 9 calls every hour, forever — a far bigger commitment
 * than a one-off search. 20 keeps a single watch under ~3 minutes of each
 * sweep.
 */
export const MAX_WATCH_FACILITIES = 20;

/**
 * Active watches one user may hold. Deliberately 1 while scanning is a single
 * in-process loop: a watch is swept forever, so per-user cost is unbounded
 * without this, and `MAX_WATCH_FACILITIES` alone caps only one watch's size,
 * not how many a user creates. Raise it once the worker owns scanning and we
 * can measure total watched campgrounds against sweep cadence.
 */
export const MAX_WATCHES_PER_USER = 1;
