import {
  addDays,
  dayOfWeek,
  eachDay,
  fetchFacilityAvailability,
  fmt,
  getQueueDepth,
  getRateLimitState,
  type ISODate,
} from "@campingmeow/scanner";
import type { FacilityStatus } from "@campingmeow/database";
import { ValidationError } from "~/lib/errors";
import { toSiteTypes, type SiteType } from "~/lib/site-types";
import { HORIZON_DAYS, MAX_SEARCH_FACILITIES } from "~/lib/limits";
import { logger } from "~/lib/logger.server";
import {
  availabilityRepository,
  type EventInput,
  type SlotInput,
} from "../repositories/availability.repository.server";
import { facilityRepository } from "../repositories/facility.repository.server";
import { authService, type AuthUser } from "./auth.service.server";
import { ADMIN_PERMISSION } from "./admin.service.server";

// Pacing lives in the scanner's global rate gate (REQUEST_INTERVAL_MS in
// packages/scanner/src/rate-limit.ts), not here — otherwise concurrent callers
// each pace themselves and the real rate is however many are running at once.

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
  siteTypes: SiteType[];
  /** Null when we have never scanned this campground. */
  lastScannedAt: string | null;
  openings: OpeningResult[];
}

export interface SearchResults {
  results: FacilitySearchResult[];
  totalOpenings: number;
  windowStart: ISODate;
  windowEnd: ISODate;
  /** Campgrounds with no scan yet — "no openings" would be a lie for these. */
  unscanned: string[];
  /** Oldest scan among the campgrounds searched — how stale the answer is. */
  oldestScannedAt: string | null;
}

export interface ScanSummary {
  facilityId: string;
  facilityName: string;
  sites: number;
  slots: number;
  freeSlots: number;
  /** Nights that flipped booked -> free on this scan. The notifier's input. */
  opened: number;
  /** Nights that flipped free -> booked. Kept so a re-open is a fresh event. */
  closed: number;
  /** What the grid said this campground is. */
  status: FacilityStatus;
}

// Domain service for campsite availability.
//   Write path: scan one campground and store what we saw. The scanner
//               (scanner.service.server.ts) decides *which* campground and when.
//   Read path : answer searches from storage. Never calls ReserveCalifornia.
export const availabilityService = {
  searchOpenings,
  recheckNonBookable,
  getFacilityCalendar,
  getWatchCalendar,
  getRateLimitState,
  getQueueDepth,
  scanFacility,
};

/**
 * Re-scan every campground currently marked non-bookable, to see whether any
 * has gained inventory.
 *
 * Manual on purpose. Self-healing is not built yet: a seasonal campground
 * demoted in winter stays demoted until someone runs this, and re-checking
 * today's window won't reveal a campground that only opens in summer. Both are
 * known gaps, written down rather than papered over.
 */
async function recheckNonBookable(user: AuthUser): Promise<{ checked: number; nowBookable: string[] }> {
  authService.requirePermission(user, ADMIN_PERMISSION);
  const candidates = await facilityRepository.listNonBookable();
  logger.info({ action: "recheck.start", count: candidates.length, userId: user.id }, "re-checking non-bookable campgrounds");

  const nowBookable: string[] = [];
  for (const candidate of candidates) {
    try {
      const summary = await scanFacility(candidate.id);
      if (summary.status === "bookable") nowBookable.push(summary.facilityName);
    } catch (err) {
      logger.warn({ action: "recheck.failed", facilityId: candidate.id, err }, "re-check failed");
    }
  }

  logger.info({ action: "recheck.complete", checked: candidates.length, promoted: nowBookable.length }, "re-check complete");
  return { checked: candidates.length, nowBookable };
}

// ---------------------------------------------------------------- read path

/** A validated search. */
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
    fields.facilityIds = `Pick at most ${MAX_SEARCH_FACILITIES} campgrounds at a time (you picked ${facilityIds.length}).`;

  // We only hold HORIZON_DAYS of nights, so a date past it can't be answered.
  // Silently clamping would report "nothing available" for a window we never
  // looked at, which reads as "booked solid" — the worst thing we could say.
  const today = fmt(new Date());
  const horizon = addDays(today, HORIZON_DAYS);
  if (input.startDate && input.startDate > horizon)
    fields.startDate = `We only track the next ${HORIZON_DAYS} days (through ${horizon}).`;
  if (input.endDate && input.endDate > horizon)
    fields.endDate = `We only track the next ${HORIZON_DAYS} days (through ${horizon}).`;

  const windowStart = input.startDate && input.startDate > today ? input.startDate : today;
  const windowEnd = input.endDate ?? horizon;
  if (windowEnd < windowStart) fields.endDate = "End date must be on or after the start date.";

  if (Object.keys(fields).length > 0) throw new ValidationError(fields);
  return { facilityIds, checkinDays, nights: input.nights, windowStart, windowEnd };
}

async function loadFacilities(query: SearchQuery) {
  const facilities = await facilityRepository.listActiveWithPark({ facilityIds: query.facilityIds });
  if (facilities.length === 0) throw new ValidationError({ facilityIds: "Unknown campgrounds." });
  return facilities;
}

type FacilityWithPark = Awaited<ReturnType<typeof loadFacilities>>[number];

/**
 * Find stays matching a pattern, from stored availability only — this never
 * calls ReserveCalifornia, so it costs a single indexed query and scales with
 * however many people search at once.
 *
 * Freshness is the scanner's job, not the reader's: the nightly sweep fills in
 * the whole catalog and the hourly sweep keeps watched campgrounds current.
 * Results carry `lastScannedAt` so the page can say how old the answer is
 * rather than pretending it is live.
 */
async function searchOpenings(input: SearchOpeningsInput): Promise<SearchResults> {
  const query = parseSearch(input);
  return buildResults(query, await loadFacilities(query));
}

export interface CalendarAvailability {
  facilityId: string;
  facilityName: string;
  parkName: string;
  siteTypes: SiteType[];
  /** ReserveCalifornia's own ids, for deep-linking past our 63-day window. */
  rcPlaceId: number;
  rcFacilityId: number;
  /** yyyy-MM-dd nights to mark available. */
  freeDates: ISODate[];
  /** Null = never scanned, so the calendar means "unknown", not "nothing free". */
  lastScannedAt: string | null;
  windowStart: ISODate;
  windowEnd: ISODate;
}

/**
 * Nights with at least one bookable site, for a campground's calendar.
 *
 * "Available" here is deliberately loose — any site, any single night. It
 * answers "is it worth looking at this date", which is what someone browsing a
 * campground wants. `getWatchCalendar` uses the stricter definition.
 */
async function getFacilityCalendar(facilityId: string): Promise<CalendarAvailability | null> {
  const facility = await facilityRepository.findByIdWithPark(facilityId);
  if (!facility || !facility.active) return null;

  const windowStart = fmt(new Date());
  const windowEnd = addDays(windowStart, HORIZON_DAYS);
  const slots = await availabilityRepository.listFreeSlots([facilityId], toDate(windowStart), toDate(windowEnd));

  return {
    facilityId: facility.id,
    facilityName: facility.name,
    parkName: facility.park.name,
    siteTypes: toSiteTypes(facility.siteCategories),
    rcPlaceId: facility.park.rcPlaceId,
    rcFacilityId: facility.rcFacilityId,
    freeDates: [...new Set(slots.map((slot) => fmt(slot.date)))].sort(),
    lastScannedAt: facility.lastScannedAt ? facility.lastScannedAt.toISOString() : null,
    windowStart,
    windowEnd,
  };
}

/**
 * The same calendar, but only marking days a watch could actually book: the
 * check-in must fall on a wanted weekday AND the whole stay must be free on one
 * site. A green Friday you can't book for your two nights is worse than no
 * calendar at all.
 */
async function getWatchCalendar(
  facilityId: string,
  checkinDays: number[],
  nights: number,
): Promise<CalendarAvailability | null> {
  const base = await getFacilityCalendar(facilityId);
  if (!base) return null;

  const slots = await availabilityRepository.listFreeSlots(
    [facilityId],
    toDate(base.windowStart),
    toDate(base.windowEnd),
  );

  // Reuse the search matcher so the calendar and the emails can never disagree
  // about what counts as a match.
  const units = new Map<number, { name: string; freeNights: Set<ISODate> }>();
  for (const slot of slots) {
    let unit = units.get(slot.unitId);
    if (!unit) {
      unit = { name: slot.unitName, freeNights: new Set() };
      units.set(slot.unitId, unit);
    }
    unit.freeNights.add(fmt(slot.date));
  }

  const openings = findOpenings([...units.values()], checkinDays, nights, base.windowStart, base.windowEnd);
  return { ...base, freeDates: openings.map((o) => o.checkin) };
}

/** Turn stored slots into the shape the page renders. */
async function buildResults(query: SearchQuery, facilities: FacilityWithPark[]): Promise<SearchResults> {
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
  let totalOpenings = 0;
  let oldestScannedAt: Date | null = null;

  for (const facility of facilities) {
    // A campground we have never scanned has no data at all, so "nothing open"
    // would be a lie — the page says so explicitly instead.
    if (!facility.lastScannedAt) unscanned.push(facility.name);
    else if (!oldestScannedAt || facility.lastScannedAt < oldestScannedAt) oldestScannedAt = facility.lastScannedAt;

    const units = [...(byFacility.get(facility.id)?.values() ?? [])];
    const openings = findOpenings(units, query.checkinDays, query.nights, query.windowStart, query.windowEnd);
    totalOpenings += openings.length;
    results.push({
      facilityId: facility.id,
      facilityName: facility.name,
      parkName: facility.park.name,
      siteTypes: toSiteTypes(facility.siteCategories),
      lastScannedAt: facility.lastScannedAt ? facility.lastScannedAt.toISOString() : null,
      openings,
    });
  }

  return {
    results,
    totalOpenings,
    windowStart: query.windowStart,
    windowEnd: query.windowEnd,
    unscanned,
    oldestScannedAt: oldestScannedAt ? oldestScannedAt.toISOString() : null,
  };
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

  // The "before" picture. Read outside the transaction deliberately: only
  // another scan of this same facility could change it, and scanFacility's
  // in-flight map already guarantees there isn't one. The write below is still
  // atomic, which is what actually matters.
  const previous = await availabilityRepository.listWindow(facility.id, toDate(start), toDate(end));
  const events = diffEvents(previous, slots);

  await availabilityRepository.replaceWindow(facility.id, toDate(start), toDate(end), slots, events);

  // What the grid returned tells us what kind of campground this is. Units with
  // none bookable means first-come, first-served; no units at all means there
  // is nothing here to reserve. Neither can ever produce a cancellation, so
  // neither is worth scanning again.
  const status =
    availability.sites.length > 0
      ? "bookable"
      : availability.totalUnits > 0
        ? "first_come_first_served"
        : "no_inventory";
  await facilityRepository.setStatus(facility.id, status, availability.sites.length, {
    siteCategories: availability.categories,
    maxVehicleLength: availability.maxVehicleLength,
  });

  const summary: ScanSummary = {
    facilityId: facility.id,
    facilityName: facility.name,
    sites: availability.sites.length,
    slots: slots.length,
    freeSlots: slots.filter((s) => s.isFree).length,
    opened: events.filter((e) => e.type === "opened").length,
    closed: events.filter((e) => e.type === "closed").length,
    status,
  };
  logger.info({ action: "scan.facility.complete", ...summary }, "facility scan complete");
  return summary;
}

/**
 * Compare what we stored last scan against what ReserveCalifornia just told
 * us, and return the transitions.
 *
 * The rule that matters: **a night with no previous row produces no event.**
 * Going from "we had no data" to "40 nights free" is discovery, not 40 things
 * opening — that happens on a campground's first scan, when a new site appears
 * in the grid, and every day as a fresh date rolls into the booking window.
 * Treat those as opens and a new watch fires dozens of emails immediately.
 */
function diffEvents(previous: { unitId: number; date: Date; isFree: boolean }[], next: SlotInput[]): EventInput[] {
  const before = new Map<string, boolean>();
  for (const slot of previous) before.set(slotKey(slot.unitId, slot.date), slot.isFree);

  const events: EventInput[] = [];
  for (const slot of next) {
    const was = before.get(slotKey(slot.unitId, slot.date));
    if (was === undefined || was === slot.isFree) continue;
    events.push({
      unitId: slot.unitId,
      unitName: slot.unitName,
      date: slot.date,
      type: slot.isFree ? "opened" : "closed",
    });
  }
  return events;
}

function slotKey(unitId: number, date: Date): string {
  return `${unitId}:${date.toISOString().slice(0, 10)}`;
}

function toDate(iso: ISODate): Date {
  return new Date(`${iso}T00:00:00Z`);
}
