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
  sites: SiteAvailability[];
}

/** Merge one grid response's slices into a site map. */
export function mergeGrid(
  grid: GridResponse,
  into: Map<number, SiteAvailability>
): void {
  const units = grid.Facility?.Units;
  if (!units) return;
  for (const unit of Object.values(units)) {
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
}

/**
 * Pull the full grid for a facility across [startDate, endDate] by paging in
 * ~2-week chunks (each grid call returns ~3 weeks of slices; we step 14 days so
 * chunks overlap and nothing is missed).
 */
export async function fetchFacilityAvailability(
  facilityId: number,
  startDate: ISODate,
  endDate: ISODate,
  delayMs: number
): Promise<FacilityAvailability> {
  const sites = new Map<number, SiteAvailability>();
  let facilityName = `Facility ${facilityId}`;
  let minDate: ISODate | null = null;
  let maxDate: ISODate | null = null;

  for (let cursor = startDate; cursor <= endDate; cursor = addDays(cursor, 14)) {
    const grid = await getGrid(facilityId, cursor, 1);
    if (grid.Facility?.Name) facilityName = grid.Facility.Name;
    if (grid.MinDate) minDate = grid.MinDate;
    if (grid.MaxDate) maxDate = grid.MaxDate;
    mergeGrid(grid, sites);
    if (cursor <= endDate) await sleep(delayMs);
  }

  return {
    facilityName,
    minDate,
    maxDate,
    sites: [...sites.values()],
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
