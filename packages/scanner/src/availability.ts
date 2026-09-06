// Paged availability fetching. This stays in the client layer: it only
// assembles the full grid for a facility (the API returns ~3 weeks per call).
// Deciding what an "opening" is belongs to domain services, not this package.

import { getGrid } from "./api.js";
import { addDays, type ISODate } from "./dates.js";
import type { GridResponse } from "./types.js";

/** One bookable site with the set of nights it is free. */
export interface SiteAvailability {
  unitId: number;
  name: string;
  freeNights: Set<ISODate>;
}

export interface FacilityAvailability {
  facilityName: string;
  minDate: ISODate | null;
  maxDate: ISODate | null;
  /** Sites a normal person can book online. */
  sites: SiteAvailability[];
  /**
   * Every unit the grid returned, bookable or not. The difference between this
   * and `sites.length` is what distinguishes a first-come, first-served
   * campground (units exist, none bookable) from one with no inventory at all.
   */
  totalUnits: number;
}

/**
 * Merge one grid response's slices into a site map, and report how many units
 * it contained in total.
 *
 * The total matters: filtering straight to bookable units throws away the only
 * signal that separates "first-come, first-served" from "nothing here at all".
 */
export function mergeGrid(
  grid: GridResponse,
  into: Map<number, SiteAvailability>
): { totalUnits: number } {
  const units = grid.Facility?.Units;
  if (!units) return { totalUnits: 0 };
  const all = Object.values(units);
  for (const unit of all) {
    // Only sites a normal person can actually book online.
    if (!unit.AllowWebBooking || !unit.IsWebViewable) continue;
    let site = into.get(unit.UnitId);
    if (!site) {
      site = { unitId: unit.UnitId, name: unit.Name, freeNights: new Set() };
      into.set(unit.UnitId, site);
    }
    for (const slice of Object.values(unit.Slices ?? {})) {
      if (slice.IsFree) site.freeNights.add(slice.Date);
    }
  }
  return { totalUnits: all.length };
}

/** Latest date any slice in this response covers, so we can page past it. */
function lastCoveredDate(grid: GridResponse): ISODate | null {
  let last: ISODate | null = null;
  for (const unit of Object.values(grid.Facility?.Units ?? {})) {
    for (const slice of Object.values(unit.Slices ?? {})) {
      if (!last || slice.Date > last) last = slice.Date;
    }
  }
  return last;
}

/** Only used when a response carries no slices at all and we must still advance. */
const FALLBACK_STEP_DAYS = 14;

/**
 * Pull the full grid for a facility across [startDate, endDate].
 *
 * The API caps each response at ~21 days regardless of what you ask for
 * (`Nights` and `EndDate` don't widen it, and it's one facility per call), so
 * the only way to cover a season is to page. We advance to the day after
 * whatever the response actually covered rather than assuming a fixed step: a
 * hardcoded 14-day step re-fetched a week of slices on every call, and would
 * silently leave gaps if the cap ever changed.
 *
 * Pacing is not this function's job: every call inside goes through the global
 * rate gate (see rate-limit.ts), so it runs as fast as the process budget
 * allows and no faster.
 */
export async function fetchFacilityAvailability(
  facilityId: number,
  startDate: ISODate,
  endDate: ISODate
): Promise<FacilityAvailability> {
  const sites = new Map<number, SiteAvailability>();
  let facilityName = `Facility ${facilityId}`;
  let minDate: ISODate | null = null;
  let maxDate: ISODate | null = null;

  let totalUnits = 0;
  let cursor = startDate;
  while (cursor <= endDate) {
    const grid = await getGrid(facilityId, cursor, 1);
    if (grid.Facility?.Name) facilityName = grid.Facility.Name;
    if (grid.MinDate) minDate = grid.MinDate;
    if (grid.MaxDate) maxDate = grid.MaxDate;
    // Highest across the window: a unit missing from one page is still real.
    totalUnits = Math.max(totalUnits, mergeGrid(grid, sites).totalUnits);

    const covered = lastCoveredDate(grid);
    let next = covered ? addDays(covered, 1) : addDays(cursor, FALLBACK_STEP_DAYS);
    // Never allow a stalled cursor to spin us into an infinite request loop.
    if (next <= cursor) next = addDays(cursor, FALLBACK_STEP_DAYS);

    // Nothing past the facility's bookable window is worth a request.
    if (maxDate && next > maxDate) break;

    cursor = next;
  }

  return {
    facilityName,
    minDate,
    maxDate,
    sites: [...sites.values()],
    totalUnits,
  };
}
