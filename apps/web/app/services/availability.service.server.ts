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
import { distanceMiles } from "~/lib/geo";
import { toSiteTypes, type SiteType } from "~/lib/site-types";
import { HORIZON_DAYS } from "~/lib/limits";
import { logger } from "~/lib/logger.server";
import {
  availabilityRepository,
  type EventInput,
  type SlotInput,
} from "../repositories/availability.repository.server";
import { facilityRepository } from "../repositories/facility.repository.server";
import { parkRepository } from "../repositories/park.repository.server";

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
  /**
   * Nights this response claimed were free that RC had never reported before.
   * A running count of how often ReserveCalifornia invents availability.
   */
  fabricated: number;
  /** Nights actually written this scan. Steady state should be a handful. */
  changed: number;
  /** Nights dropped because the grid no longer lists them. */
  removed: number;
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
  findNearby,
  getFacilityCalendar,
  getWatchCalendar,
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

  // No upper bound: this is one indexed query against our own database, and
  // the catalog itself (~500 campgrounds) is the only ceiling that matters.
  const facilityIds = [...new Set(input.facilityIds)];
  if (facilityIds.length === 0) fields.facilityIds = "Pick at least one campground.";

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
 * duplicate requests out of a budget we can't afford, and two `applyWindowDelta`
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

  const windowDates = eachDay(start, end);
  const slots = toSlots(availability, windowDates);

  // The "before" picture. Read outside the transaction deliberately: only
  // another scan of this same facility could change it, and scanFacility's
  // in-flight map already guarantees there isn't one. The write below is still
  // atomic, which is what actually matters.
  const previous = await availabilityRepository.listWindow(facility.id, toDate(start), toDate(end));

  // Throw out invented availability before anything reads it. See
  // dropFabricated — this is what stops a broken RC server's phantom openings
  // becoming email, and it needs no second request.
  const fabricated = dropFabricated(previous, slots);

  const events = diffEvents(previous, slots);
  const delta = diffSlots(previous, slots);
  await availabilityRepository.applyWindowDelta(facility.id, delta, events);

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
    changed: delta.upserts.length,
    removed: delta.removals.length,
    opened: events.filter((e) => e.type === "opened").length,
    closed: events.filter((e) => e.type === "closed").length,
    fabricated,
    status,
  };
  if (fabricated > 0) {
    // Worth its own line: this is the measure of how often ReserveCalifornia
    // invents availability, across the whole catalog. A season legitimately
    // reopening also lands here, which is why it is logged rather than silent.
    logger.warn(
      { action: "scan.fabricated", facilityId: facility.id, facilityName: facility.name, fabricated },
      "response claimed nights RC had never reported; ignored them",
    );
  }
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
/**
 * What actually changed in a facility's window.
 *
 * A scan produces the whole window every time, but between two passes 25
 * minutes apart almost none of it has moved. Writing only the difference keeps
 * a steady-state scan to a handful of rows instead of thousands.
 *
 * `upserts` covers both new nights and nights whose availability (or site
 * name) changed; `removals` covers nights that were stored but are no longer
 * in the grid at all — a site retired, or a date that rolled out of view.
 */
/**
 * Flatten a grid read into one row per site per night.
 *
 * Every date in the window gets a row, taken ones included, so a search can
 * tell "booked" apart from "never scanned".
 */
function toSlots(
  availability: Awaited<ReturnType<typeof fetchFacilityAvailability>>,
  windowDates: ISODate[],
): SlotInput[] {
  return availability.sites.flatMap((site) =>
    windowDates.map((date) => ({
      unitId: site.unitId,
      unitName: site.name,
      date: toDate(date),
      isFree: site.freeNights.has(date),
      reported: site.reportedNights.has(date),
    })),
  );
}

/**
 * Throw out availability ReserveCalifornia invented.
 *
 * RC omits nights a site is not offered for — a dorm block closed for the
 * season, say — and a broken server in their fleet fills those gaps in and
 * marks them free. Measured 2026-09-19: one dorm returned 2 nights in a healthy
 * response and 21 in a bad one, 19 of them fabricated. That produced ~100
 * phantom openings at a time and four "36 campsites just opened" emails a day
 * to a real user. See packages/scanner/API.md §4c.
 *
 * Absence is the tell, and it is reliable: six identical reads returned exactly
 * the same set of nights. So a night going **absent -> free** is invention,
 * while **reported-and-taken -> free** is a genuine cancellation.
 *
 * Fabricated nights are carried forward — the stored row is left exactly as it
 * was — rather than recorded as taken. Recording them would launder the lie
 * into a legitimate baseline, and the *next* bad response would then read as a
 * real cancellation and send the email we are trying to prevent.
 *
 * A season genuinely reopening looks identical and is suppressed too. That is
 * accepted: we are here to catch cancellations, and it is logged rather than
 * silent.
 *
 * `slots` is mutated in place. Returns how many nights were ignored.
 */
function dropFabricated(
  previous: { unitId: number; unitName: string; date: Date; isFree: boolean; reported: boolean }[],
  slots: SlotInput[],
): number {
  const before = new Map(previous.map((slot) => [slotKey(slot.unitId, slot.date), slot]));

  let fabricated = 0;
  for (const slot of slots) {
    if (!slot.isFree) continue;
    const was = before.get(slotKey(slot.unitId, slot.date));
    // No stored row at all is discovery, not invention — a new site, or a date
    // that has just rolled into the window. diffEvents already stays quiet for
    // those, so let them through and be recorded.
    if (!was || was.reported) continue;

    // Carry the stored row forward untouched, so the diff sees no change.
    slot.isFree = was.isFree;
    slot.reported = was.reported;
    slot.unitName = was.unitName;
    fabricated++;
  }
  return fabricated;
}

function diffSlots(
  previous: { unitId: number; unitName: string; date: Date; isFree: boolean; reported: boolean }[],
  next: SlotInput[],
): { upserts: SlotInput[]; removals: { unitId: number; date: Date }[] } {
  const before = new Map(previous.map((slot) => [slotKey(slot.unitId, slot.date), slot]));

  const upserts: SlotInput[] = [];
  for (const slot of next) {
    const key = slotKey(slot.unitId, slot.date);
    const was = before.get(key);
    before.delete(key);
    // Unchanged nights are the overwhelming majority; leave them alone.
    // `reported` belongs in this comparison: a night going from absent to
    // reported-and-taken leaves isFree false on both sides, and without it that
    // row would never be written — so the baseline a real opening is measured
    // against would never get established.
    if (was && was.isFree === slot.isFree && was.unitName === slot.unitName && was.reported === slot.reported) {
      continue;
    }
    upserts.push(slot);
  }

  // Whatever is left was stored but the grid no longer reports it.
  const removals = [...before.values()].map(({ unitId, date }) => ({ unitId, date }));
  return { upserts, removals };
}

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

/**
 * "I want to go camping — where can I go?"
 *
 * One row per campground within the radius, one column per night in the
 * scanned window, and a count of how many sites are free on each. The counting
 * happens in Postgres; a wide radius is ~9,500 aggregated rows rather than the
 * ~70,000 raw slots behind them.
 *
 * A cell means **one site free that night**. It deliberately says nothing about
 * consecutive nights: two green cells side by side can be two different sites,
 * so a two-night stay is not implied. The UI says so out loud rather than
 * letting a run of green promise something we have not checked.
 */
export interface NearbyInput {
  latitude: number;
  longitude: number;
  radiusMiles: number;
  /** RC UnitCategoryIds to keep; empty means every type. */
  siteCategories?: number[];
}

export interface NearbyCampground {
  facilityId: string;
  facilityName: string;
  parkId: string;
  parkName: string;
  distanceMiles: number;
  siteTypes: SiteType[];
  /** Free sites keyed by night, yyyy-MM-dd. Nights with none are absent. */
  freeByDate: Record<string, number>;
  /** Nights with at least one free site — what "most availability" sorts on. */
  openNights: number;
  lastScannedAt: string | null;
}

export interface NearbyResults {
  /** The column axis: every night in the scanned window, in order. */
  dates: ISODate[];
  campgrounds: NearbyCampground[];
  /** Within range and scanned, but nothing free — filtered out of the grid. */
  fullyBookedCount: number;
  /** Staleness of the freshest thing we are showing. */
  oldestScannedAt: string | null;
}

/** Widest search we will run. Well past useful; exists so a hand-edited URL can't ask for the planet. */
const MAX_RADIUS_MILES = 500;

async function findNearby(input: NearbyInput): Promise<NearbyResults> {
  const fields: Record<string, string> = {};
  if (!Number.isFinite(input.latitude) || Math.abs(input.latitude) > 90) fields.latitude = "Invalid location.";
  if (!Number.isFinite(input.longitude) || Math.abs(input.longitude) > 180) fields.longitude = "Invalid location.";
  if (!Number.isFinite(input.radiusMiles) || input.radiusMiles <= 0 || input.radiusMiles > MAX_RADIUS_MILES)
    fields.radiusMiles = `Pick a distance between 1 and ${MAX_RADIUS_MILES} miles.`;
  if (Object.keys(fields).length > 0) throw new ValidationError(fields);

  const windowStart = fmt(new Date());
  const windowEnd = addDays(windowStart, HORIZON_DAYS);
  const dates = eachDay(windowStart, windowEnd);

  // Distance is computed here rather than in SQL: there are only ~300 parks, so
  // this is a few hundred haversines against a query we already know how to run.
  const parks = await parkRepository.listActiveWithFacilities();
  const wanted = new Set(input.siteCategories ?? []);
  const inRange = new Map<string, { park: (typeof parks)[number]; distance: number }>();

  for (const park of parks) {
    // A park RC has no coordinates for cannot be placed, so it cannot be near
    // anything. Excluding it is honest; guessing a location would not be.
    if (park.latitude === null || park.longitude === null) continue;
    const distance = distanceMiles(
      { latitude: input.latitude, longitude: input.longitude },
      { latitude: park.latitude, longitude: park.longitude },
    );
    if (distance <= input.radiusMiles) inRange.set(park.id, { park, distance });
  }

  const candidates = [...inRange.values()].flatMap(({ park, distance }) =>
    park.facilities
      .filter((f) => wanted.size === 0 || f.siteCategories.some((c) => wanted.has(c)))
      .map((facility) => ({ facility, park, distance })),
  );
  if (candidates.length === 0) {
    return { dates, campgrounds: [], fullyBookedCount: 0, oldestScannedAt: null };
  }

  const counts = await availabilityRepository.countFreeByFacilityAndDate(
    candidates.map((c) => c.facility.id),
    toDate(windowStart),
    toDate(windowEnd),
  );

  const byFacility = new Map<string, Record<string, number>>();
  for (const row of counts) {
    const forFacility = byFacility.get(row.facilityId) ?? {};
    forFacility[fmt(row.date)] = row._count._all;
    byFacility.set(row.facilityId, forFacility);
  }

  let fullyBookedCount = 0;
  let oldestScannedAt: number | null = null;
  const campgrounds: NearbyCampground[] = [];

  for (const { facility, park, distance } of candidates) {
    const freeByDate = byFacility.get(facility.id);
    // Nothing free anywhere in the window. Dropped rather than shown as an
    // empty row: a screen of grey is noise, not information.
    if (!freeByDate) {
      if (facility.lastScannedAt) fullyBookedCount++;
      continue;
    }
    if (facility.lastScannedAt) {
      const scanned = facility.lastScannedAt.getTime();
      if (oldestScannedAt === null || scanned < oldestScannedAt) oldestScannedAt = scanned;
    }
    campgrounds.push({
      facilityId: facility.id,
      facilityName: facility.name,
      parkId: park.id,
      parkName: park.name,
      distanceMiles: Math.round(distance),
      siteTypes: toSiteTypes(facility.siteCategories),
      freeByDate,
      openNights: Object.keys(freeByDate).length,
      lastScannedAt: facility.lastScannedAt ? facility.lastScannedAt.toISOString() : null,
    });
  }

  campgrounds.sort(
    (a, b) =>
      a.distanceMiles - b.distanceMiles ||
      a.parkName.localeCompare(b.parkName) ||
      a.facilityName.localeCompare(b.facilityName),
  );

  return {
    dates,
    campgrounds,
    fullyBookedCount,
    oldestScannedAt: oldestScannedAt ? new Date(oldestScannedAt).toISOString() : null,
  };
}
