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
import { ValidationError } from "~/lib/errors";
import { MAX_SEARCH_FACILITIES } from "~/lib/limits";
import { logger } from "~/lib/logger.server";
import {
  availabilityRepository,
  type EventInput,
  type SlotInput,
} from "../repositories/availability.repository.server";
import { facilityRepository } from "../repositories/facility.repository.server";

// Pacing lives in the scanner's global rate gate (REQUEST_INTERVAL_MS in
// packages/scanner/src/rate-limit.ts), not here — otherwise concurrent callers
// each pace themselves and the real rate is however many are running at once.
/** How far ahead we scan; ReserveCalifornia books ~6 months out. */
const HORIZON_DAYS = 180;

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
}

// Domain service for campsite availability.
//   Write path: scan one campground and store what we saw. The scanner
//               (scanner.service.server.ts) decides *which* campground and when.
//   Read path : answer searches from storage. Never calls ReserveCalifornia.
export const availabilityService = {
  searchOpenings,
  getRateLimitState,
  getQueueDepth,
  scanFacility,
};

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

  const today = fmt(new Date());
  const windowStart = input.startDate && input.startDate > today ? input.startDate : today;
  const windowEnd = input.endDate ?? addDays(today, HORIZON_DAYS);
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

  const summary: ScanSummary = {
    facilityId: facility.id,
    facilityName: facility.name,
    sites: availability.sites.length,
    slots: slots.length,
    freeSlots: slots.filter((s) => s.isFree).length,
    opened: events.filter((e) => e.type === "opened").length,
    closed: events.filter((e) => e.type === "closed").length,
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
