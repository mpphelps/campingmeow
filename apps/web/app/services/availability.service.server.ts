import {
  addDays,
  dayOfWeek,
  eachDay,
  fetchFacilityAvailability,
  fmt,
  getQueueDepth,
  getRateLimitState,
  RateLimitedError,
  type ISODate,
} from "@campingmeow/scanner";
import { ValidationError } from "~/lib/errors";
import { MAX_SEARCH_FACILITIES } from "~/lib/limits";
import { logger } from "~/lib/logger.server";
import { availabilityRepository } from "../repositories/availability.repository.server";
import { facilityRepository } from "../repositories/facility.repository.server";
import { watchRepository } from "../repositories/watch.repository.server";
import { authService, type AuthUser } from "./auth.service.server";
import { ADMIN_PERMISSION } from "./admin.service.server";

// Pacing lives in the scanner's global rate gate (REQUEST_INTERVAL_MS in
// packages/scanner/src/rate-limit.ts), not here — otherwise concurrent callers
// each pace themselves and the real rate is however many are running at once.
/** How far ahead we scan; ReserveCalifornia books ~6 months out. */
const HORIZON_DAYS = 180;
/** Stored availability older than this is refreshed after a search answers. */
const FRESHNESS_MS = 5 * 60 * 1000;

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export interface SearchOpeningsInput {
  facilityIds: string[];
  /** 0=Sun .. 6=Sat */
  checkinDays: number[];
  nights: number;
  /** yyyy-MM-dd, null = the full stored window */
  startDate: string | null;
  endDate: string | null;
}

export interface OpeningResult {
  checkin: ISODate;
  dayLabel: string;
  siteNames: string[];
}

export interface FacilitySearchResult {
  facilityId: string;
  facilityName: string;
  parkName: string;
  /** Null when we have never scanned this campground. */
  lastScannedAt: string | null;
  /** Data is older than the freshness window and a refresh is still pending. */
  isStale: boolean;
  openings: OpeningResult[];
}

export interface SearchResults {
  results: FacilitySearchResult[];
  totalOpenings: number;
  windowStart: ISODate;
  windowEnd: ISODate;
  /** Campgrounds with no scan yet — "no openings" would be a lie for these. */
  unscanned: string[];
  /** Campgrounds whose refresh failed: what's shown is older than we'd like. */
  stale: string[];
  /** How many campgrounds are still waiting on a refresh. */
  staleCount: number;
}

/**
 * A step in a background refresh, streamed to the page over SSE. Each one
 * carries a complete replacement `results` snapshot so the page only ever
 * swaps state in — it never has to merge or recount anything itself.
 */
export type SearchProgressEvent =
  | { type: "progress"; done: number; total: number; facilityName: string; results: SearchResults }
  | { type: "done"; refreshed: number; failed: number }
  /** Emitted by the SSE route, not the generator, when the refresh blows up. */
  | { type: "error"; message: string };

export interface ScanSummary {
  facilityId: string;
  facilityName: string;
  sites: number;
  slots: number;
  freeSlots: number;
}

export interface SweepState {
  running: boolean;
  scope: "watched" | "all" | null;
  total: number;
  done: number;
  failed: number;
  startedAt: string | null;
  finishedAt: string | null;
  currentFacility: string | null;
  /** Set when a sweep stopped early because we got rate-limited. */
  blockedUntil: string | null;
  /** True when an admin stopped the last sweep by hand. */
  cancelled: boolean;
}

/**
 * Progress of the running sweep. In memory only: a full sweep takes ~55
 * minutes and this is a stopgap until the Phase 3 worker owns scanning, so a
 * server restart forgets it (the scans themselves are already durable).
 */
let sweepState: SweepState = {
  running: false,
  scope: null,
  total: 0,
  done: 0,
  failed: 0,
  startedAt: null,
  finishedAt: null,
  currentFacility: null,
  blockedUntil: null,
  cancelled: false,
};

/**
 * Raised between campgrounds to stop a running sweep. A full sweep is ~1.5
 * hours of continuous requests, so an admin who starts one by mistake needs a
 * way out that isn't restarting the server.
 */
let cancelRequested = false;

// Domain service for campsite availability.
//   Write path: scan ReserveCalifornia and store what we saw.
//   Read path : answer searches from storage, refreshing stale campgrounds.
export const availabilityService = {
  searchOpenings,
  refreshSearch,
  getRateLimitState,
  getQueueDepth,
  scanFacility,
  scanWatchedFacilities,
  startSweep,
  cancelSweep,
  getSweepState,
};

function getSweepState(): SweepState {
  return sweepState;
}

// ---------------------------------------------------------------- read path

/** A validated search: the shape both the read and the refresh path work from. */
interface SearchQuery {
  facilityIds: string[];
  checkinDays: number[];
  nights: number;
  windowStart: ISODate;
  windowEnd: ISODate;
}

function parseSearch(input: SearchOpeningsInput): SearchQuery {
  const fields: Record<string, string> = {};

  const checkinDays = [...new Set(input.checkinDays)].sort();
  if (checkinDays.length === 0) fields.checkinDays = "Pick at least one check-in day.";
  else if (checkinDays.some((d) => !Number.isInteger(d) || d < 0 || d > 6))
    fields.checkinDays = "Check-in days must be days of the week.";

  if (!Number.isInteger(input.nights) || input.nights < 1 || input.nights > 7)
    fields.nights = "Nights must be between 1 and 7.";

  const facilityIds = [...new Set(input.facilityIds)];
  if (facilityIds.length === 0) fields.facilityIds = "Pick at least one campground.";
  else if (facilityIds.length > MAX_SEARCH_FACILITIES)
    fields.facilityIds = `Searching checks each campground live, so pick at most ${MAX_SEARCH_FACILITIES} at a time (you picked ${facilityIds.length}).`;

  const today = fmt(new Date());
  const windowStart = input.startDate && input.startDate > today ? input.startDate : today;
  const windowEnd = input.endDate ?? addDays(today, HORIZON_DAYS);
  if (windowEnd < windowStart) fields.endDate = "End date must be on or after the start date.";

  if (Object.keys(fields).length > 0) throw new ValidationError(fields);
  return { facilityIds, checkinDays, nights: input.nights, windowStart, windowEnd };
}

/** True when a campground's stored availability is old enough to re-scan. */
function needsRefresh(facility: { lastScannedAt: Date | null }): boolean {
  return !facility.lastScannedAt || facility.lastScannedAt.getTime() < Date.now() - FRESHNESS_MS;
}

async function loadFacilities(query: SearchQuery) {
  const facilities = await facilityRepository.listActiveWithPark({ facilityIds: query.facilityIds });
  if (facilities.length === 0) throw new ValidationError({ facilityIds: "Unknown campgrounds." });
  return facilities;
}

type FacilityWithPark = Awaited<ReturnType<typeof loadFacilities>>[number];

/**
 * Find stays matching a pattern, from stored availability only. Answers in
 * milliseconds — it never calls ReserveCalifornia. Campgrounds due a refresh
 * come back flagged `isStale`; `refreshSearch` brings those up to date in the
 * background so the page renders at once and fills in as scans land.
 */
async function searchOpenings(input: SearchOpeningsInput): Promise<SearchResults> {
  const query = parseSearch(input);
  return buildResults(query, await loadFacilities(query), new Set());
}

/**
 * Turn stored slots into the shape the page renders. `failedIds` are
 * campgrounds whose refresh just failed: they are no longer pending, so they
 * report as stale (or unscanned) rather than as still-refreshing.
 */
async function buildResults(
  query: SearchQuery,
  facilities: FacilityWithPark[],
  failedIds: Set<string>,
): Promise<SearchResults> {
  const slots = await availabilityRepository.listFreeSlots(
    facilities.map((f) => f.id),
    toDate(query.windowStart),
    toDate(query.windowEnd),
  );

  // facilityId -> unitId -> { name, freeNights }
  const byFacility = new Map<string, Map<number, { name: string; freeNights: Set<ISODate> }>>();
  for (const slot of slots) {
    let units = byFacility.get(slot.facilityId);
    if (!units) {
      units = new Map();
      byFacility.set(slot.facilityId, units);
    }
    let unit = units.get(slot.unitId);
    if (!unit) {
      unit = { name: slot.unitName, freeNights: new Set() };
      units.set(slot.unitId, unit);
    }
    unit.freeNights.add(fmt(slot.date));
  }

  const results: FacilitySearchResult[] = [];
  const unscanned: string[] = [];
  const stale: string[] = [];
  let totalOpenings = 0;
  let staleCount = 0;

  for (const facility of facilities) {
    const pending = needsRefresh(facility) && !failedIds.has(facility.id);

    // Only report a problem once the refresh has actually had its turn.
    // Everything still queued is "checking now", not "we have nothing" — the
    // stream is on its way to fixing it, and saying otherwise sends people off
    // to create a watch they don't need.
    if (pending) staleCount++;
    // A campground we have never scanned has no older data to fall back on, so
    // it reports as unscanned rather than stale even when its refresh failed.
    else if (!facility.lastScannedAt) unscanned.push(facility.name);
    else if (failedIds.has(facility.id)) stale.push(facility.name);

    const units = [...(byFacility.get(facility.id)?.values() ?? [])];
    const openings = findOpenings(units, query.checkinDays, query.nights, query.windowStart, query.windowEnd);
    totalOpenings += openings.length;
    results.push({
      facilityId: facility.id,
      facilityName: facility.name,
      parkName: facility.park.name,
      lastScannedAt: facility.lastScannedAt ? facility.lastScannedAt.toISOString() : null,
      isStale: pending,
      openings,
    });
  }

  return {
    results,
    totalOpenings,
    windowStart: query.windowStart,
    windowEnd: query.windowEnd,
    unscanned,
    stale,
    staleCount,
  };
}

/**
 * Bring every stale campground in a search up to date, one at a time, yielding
 * a fresh snapshot after each. Runs only as long as the caller listens: the SSE
 * route passes the request's abort signal, so closing the page stops the scans
 * rather than leaving them hammering ReserveCalifornia for nobody.
 */
async function* refreshSearch(
  input: SearchOpeningsInput,
  options: { signal?: AbortSignal } = {},
): AsyncGenerator<SearchProgressEvent> {
  const query = parseSearch(input);
  let facilities = await loadFacilities(query);

  // Oldest (and never-scanned) first — those benefit most from a refresh.
  const pending = facilities
    .filter(needsRefresh)
    .sort((a, b) => (a.lastScannedAt?.getTime() ?? 0) - (b.lastScannedAt?.getTime() ?? 0));

  const total = pending.length;
  const failedIds = new Set<string>();
  let done = 0;
  let succeeded = 0;

  const abandoned = () => {
    if (!options.signal?.aborted) return false;
    logger.info({ action: "search.refresh_aborted", done, total }, "search refresh abandoned by client");
    return true;
  };

  for (const [index, facility] of pending.entries()) {
    if (abandoned()) return;

    let blocked = false;
    try {
      await scanFacility(facility.id);
      succeeded++;
    } catch (err) {
      failedIds.add(facility.id);
      if (err instanceof RateLimitedError) {
        // Every remaining campground would hit the same block, so stop asking
        // and report them all as stale rather than leaving them "checking".
        for (const rest of pending.slice(index + 1)) failedIds.add(rest.id);
        blocked = true;
        logger.warn({ action: "search.refresh_blocked", until: err.until }, "refresh stopped: rate limited");
      } else {
        logger.warn({ action: "search.refresh_failed", facilityId: facility.id, err }, "refresh during search failed");
      }
    }
    done++;
    // Re-check: a scan takes tens of seconds, plenty of time to lose the reader.
    if (abandoned()) return;

    // Re-read so both lastScannedAt and the new slots are reflected.
    facilities = await loadFacilities(query);
    yield {
      type: "progress",
      done: blocked ? total : done,
      total,
      facilityName: facility.name,
      results: await buildResults(query, facilities, failedIds),
    };
    if (blocked) break;
  }

  yield { type: "done", refreshed: succeeded, failed: failedIds.size };
}

/** A stay matches when one site has every night free, starting on a wanted weekday. */
function findOpenings(
  units: { name: string; freeNights: Set<ISODate> }[],
  checkinDays: number[],
  nights: number,
  rangeStart: ISODate,
  rangeEnd: ISODate,
): OpeningResult[] {
  const wanted = new Set(checkinDays.map((d) => DAY_LABELS[d]));
  const openings: OpeningResult[] = [];

  for (const checkin of eachDay(rangeStart, rangeEnd)) {
    if (!wanted.has(dayOfWeek(checkin))) continue;
    if (addDays(checkin, nights - 1) > rangeEnd) continue;

    const siteNames = units.filter((unit) => allNightsFree(unit.freeNights, checkin, nights)).map((unit) => unit.name);
    if (siteNames.length > 0) {
      openings.push({ checkin, dayLabel: dayOfWeek(checkin), siteNames: siteNames.sort() });
    }
  }
  return openings;
}

function allNightsFree(freeNights: Set<ISODate>, checkin: ISODate, nights: number): boolean {
  for (let i = 0; i < nights; i++) {
    if (!freeNights.has(addDays(checkin, i))) return false;
  }
  return true;
}

// --------------------------------------------------------------- write path

/**
 * Scans currently running, keyed by facility id. Two people searching the same
 * campground — or a search overlapping a sweep — would otherwise both scan it:
 * duplicate requests out of a budget we can't afford, and two `replaceWindow`
 * transactions racing over the same rows. The second caller waits on the first.
 */
const inFlightScans = new Map<string, Promise<ScanSummary>>();

/**
 * Scan one campground's full booking window and store the result. This is the
 * only path that talks to ReserveCalifornia; the Phase 3 worker will call it
 * on a loop.
 */
function scanFacility(facilityId: string): Promise<ScanSummary> {
  const existing = inFlightScans.get(facilityId);
  if (existing) {
    logger.debug({ action: "scan.facility.joined", facilityId }, "joined an in-flight scan");
    return existing;
  }
  const scan = runScan(facilityId).finally(() => inFlightScans.delete(facilityId));
  inFlightScans.set(facilityId, scan);
  return scan;
}

async function runScan(facilityId: string): Promise<ScanSummary> {
  const facility = await facilityRepository.findById(facilityId);
  if (!facility) throw new ValidationError({ facilityId: "Unknown campground." });

  const start = fmt(new Date());
  const end = addDays(start, HORIZON_DAYS);
  logger.info({ action: "scan.facility.start", facilityId, rcFacilityId: facility.rcFacilityId }, "scanning facility");

  const availability = await fetchFacilityAvailability(facility.rcFacilityId, start, end);

  // The grid only reports free nights per site; every date in the window that
  // a site is not free is stored as taken, so searches can tell the
  // difference between "booked" and "never scanned".
  const windowDates = eachDay(start, end);
  const slots = availability.sites.flatMap((site) =>
    windowDates.map((date) => ({
      unitId: site.unitId,
      unitName: site.name,
      date: toDate(date),
      isFree: site.freeNights.has(date),
    })),
  );

  await availabilityRepository.replaceWindow(facility.id, toDate(start), toDate(end), slots);

  const summary: ScanSummary = {
    facilityId: facility.id,
    facilityName: facility.name,
    sites: availability.sites.length,
    slots: slots.length,
    freeSlots: slots.filter((s) => s.isFree).length,
  };
  logger.info({ action: "scan.facility.complete", ...summary }, "facility scan complete");
  return summary;
}

/** Scan every campground someone is watching. Sequential, to stay polite. Admin-only. */
async function scanWatchedFacilities(user: AuthUser): Promise<{ scanned: ScanSummary[]; failed: string[] }> {
  authService.requirePermission(user, ADMIN_PERMISSION);
  const facilityIds = await watchRepository.listWatchedFacilityIds();
  logger.info({ action: "scan.sweep.start", facilities: facilityIds.length }, "sweep starting");

  const scanned: ScanSummary[] = [];
  const failed: string[] = [];
  for (const facilityId of facilityIds) {
    try {
      scanned.push(await scanFacility(facilityId));
    } catch (err) {
      logger.warn({ action: "scan.facility.failed", facilityId, err }, "facility scan failed");
      failed.push(facilityId);
    }
  }
  logger.info({ action: "scan.sweep.complete", scanned: scanned.length, failed: failed.length }, "sweep complete");
  return { scanned, failed };
}

/**
 * Kick off a sweep in the background and return immediately — a full-catalog
 * sweep is ~500 campgrounds at ~7s each (roughly an hour), far longer than a
 * request can wait. Admin-only. Poll getSweepState() for progress.
 */
async function startSweep(user: AuthUser, scope: "watched" | "all"): Promise<SweepState> {
  authService.requirePermission(user, ADMIN_PERMISSION);
  if (sweepState.running) return sweepState;

  const facilityIds =
    scope === "all"
      ? (await facilityRepository.listActiveWithPark()).map((f) => f.id)
      : await watchRepository.listWatchedFacilityIds();

  sweepState = {
    running: true,
    scope,
    total: facilityIds.length,
    done: 0,
    failed: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    currentFacility: null,
    blockedUntil: null,
    cancelled: false,
  };
  cancelRequested = false;
  logger.info({ action: "sweep.start", scope, facilities: facilityIds.length, userId: user.id }, "sweep started");

  void runSweep(facilityIds);
  return sweepState;
}

/** Ask a running sweep to stop after the campground in flight. Admin-only. */
async function cancelSweep(user: AuthUser): Promise<SweepState> {
  authService.requirePermission(user, ADMIN_PERMISSION);
  if (!sweepState.running) return sweepState;
  cancelRequested = true;
  logger.info({ action: "sweep.cancel_requested", userId: user.id, done: sweepState.done }, "sweep cancellation requested");
  return sweepState;
}

async function runSweep(facilityIds: string[]): Promise<void> {
  for (const facilityId of facilityIds) {
    // Checked between campgrounds: the scan in flight still finishes, so we
    // never leave a half-written window behind.
    if (cancelRequested) {
      logger.info({ action: "sweep.cancelled", done: sweepState.done, total: sweepState.total }, "sweep cancelled");
      sweepState = {
        ...sweepState,
        running: false,
        currentFacility: null,
        finishedAt: new Date().toISOString(),
        cancelled: true,
      };
      cancelRequested = false;
      return;
    }
    try {
      const summary = await scanFacility(facilityId);
      sweepState = { ...sweepState, done: sweepState.done + 1, currentFacility: summary.facilityName };
    } catch (err) {
      if (err instanceof RateLimitedError) {
        // Grinding through the remaining campgrounds would just extend the
        // penalty. Stop the sweep and show an admin when we can try again.
        logger.error({ action: "sweep.rate_limited", until: err.until, done: sweepState.done }, "sweep stopped: rate limited");
        sweepState = {
          ...sweepState,
          running: false,
          currentFacility: null,
          finishedAt: new Date().toISOString(),
          blockedUntil: err.until.toISOString(),
        };
        return;
      }
      logger.warn({ action: "sweep.facility_failed", facilityId, err }, "sweep facility failed");
      sweepState = { ...sweepState, done: sweepState.done + 1, failed: sweepState.failed + 1 };
    }
  }
  sweepState = { ...sweepState, running: false, currentFacility: null, finishedAt: new Date().toISOString() };
  logger.info(
    { action: "sweep.complete", done: sweepState.done, failed: sweepState.failed, scope: sweepState.scope },
    "sweep complete",
  );
}

function toDate(iso: ISODate): Date {
  return new Date(`${iso}T00:00:00Z`);
}
