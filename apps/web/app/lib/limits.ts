/**
 * Caps on how much ReserveCalifornia work one user action can create.
 *
 * These used to ration API budget, back when the scanner only scanned watched
 * campgrounds. It now scans every bookable one regardless, so scan cost is a
 * function of the catalog and a watch commits us to nothing. What's left is
 * keeping one account from turning itself into an email firehose.
 */

/**
 * Campgrounds one availability search may cover. Search reads our database and
 * never calls ReserveCalifornia, so this no longer rations API budget — it just
 * bounds one query and one page of results. Kept generous.
 */
export const MAX_SEARCH_FACILITIES = 50;

/**
 * Campgrounds one watch may cover. Also no longer a scan-cost limit — it keeps a
 * single watch comprehensible, and bounds how much one email can be about.
 */
export const MAX_WATCH_FACILITIES = 20;

/**
 * Active watches one user may hold.
 *
 * This is no longer about scan cost — the scanner sweeps every bookable
 * campground regardless of who watches what, so a watch commits us to nothing.
 * It exists so one account can't create thousands of watches and turn itself
 * into an email firehose: the notifier sends at most one message per user per
 * pass, but matching cost and inbox volume still scale with what's watched.
 */
export const MAX_WATCHES_PER_USER = 10;

/**
 * Emails we allow ourselves to send in any rolling 24 hours.
 *
 * Resend's free tier is 100 a day and, per their docs, the quota "resets after
 * 24 hours" rather than at midnight — so this is a trailing window, not a
 * calendar day. Counting to midnight would let us send 100 at 11pm and 100
 * more an hour later, and Resend would refuse the second hundred.
 *
 * We stop just short of their number. Hitting our own cap pauses notifications
 * cleanly and tells the user; hitting theirs is a 429 in the middle of a batch.
 */
export const DAILY_EMAIL_LIMIT = 95;

/** The window DAILY_EMAIL_LIMIT is measured over, matching Resend's reset. */
export const EMAIL_QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How far ahead the scanner looks, and therefore how far a watch can see.
 *
 * ReserveCalifornia books ~6 months out, but two thirds of a 180-day scan went
 * to days 63-180 — the part of the window people care about least (27% of
 * weekend nights free out there, against 13% inside three weeks). 63 days is
 * three API calls, matches "I want to go camping soon", and is what makes
 * scanning the whole catalog affordable. Past it we link to
 * ReserveCalifornia rather than half-building their calendar.
 */
export const HORIZON_DAYS = 63;
