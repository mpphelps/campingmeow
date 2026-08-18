/**
 * Caps on how much ReserveCalifornia work one user action can create.
 *
 * Everything here derives from one number: the scanner makes 9 grid calls per
 * campground (21 days per call, 180-day window) at ~1 request/second, so a
 * campground costs roughly 10 seconds of API budget. Without caps, selecting
 * every park on the home page would queue ~500 campgrounds — 77 minutes of
 * continuous requests from a single IP, which is how you get blocked.
 */

/**
 * Campgrounds one live availability search may cover. At ~10s each this is a
 * worst case of ~95 seconds of streamed refreshing, which the progress bar can
 * carry honestly. Beyond that nobody waits.
 */
export const MAX_SEARCH_FACILITIES = 10;

/**
 * Campgrounds one watch may cover. Watches are swept hourly, so each one costs
 * its campground count × 9 calls every hour, forever — a far bigger commitment
 * than a one-off search. 20 keeps a single watch under ~3 minutes of each
 * sweep.
 */
export const MAX_WATCH_FACILITIES = 20;
