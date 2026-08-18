// Thin typed client for the ReserveCalifornia ("RDR") backend.
// See API.md for endpoint documentation.

import type {
  CatalogFacility,
  CatalogPlace,
  GridResponse,
  ParkMatch,
  FacilitySummary,
  SearchPlaceResponse,
} from "./types.js";

const FALLBACK_BASE =
  "https://california-rdr.prod.cali.rd12.recreation-management.tylerapp.com/rdr/";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";

let cachedBase: string | null = null;

/**
 * Hard off-switch for every call to ReserveCalifornia. The e2e suite sets it so
 * that background work triggered by a test — an initial scan after a watch is
 * created, a stale refresh during a search — can never reach the live API with
 * seeded facility ids. Callers already treat a scan failure as non-fatal.
 */
function assertOnline(): void {
  if (process.env.RC_API_OFFLINE === "1") {
    throw new Error("ReserveCalifornia API is disabled (RC_API_OFFLINE=1)");
  }
}

/**
 * Resolve the API base URL the way the website does: read it from
 * reservecalifornia.com/config.json at runtime, falling back to a known value.
 */
export async function getBaseUrl(): Promise<string> {
  assertOnline();
  if (cachedBase) return cachedBase;
  try {
    const res = await fetch("https://reservecalifornia.com/config.json", {
      headers: { "User-Agent": UA },
    });
    if (res.ok) {
      const cfg = (await res.json()) as { rdrApiUrl?: string };
      if (cfg.rdrApiUrl) {
        cachedBase = cfg.rdrApiUrl.endsWith("/")
          ? cfg.rdrApiUrl
          : cfg.rdrApiUrl + "/";
        return cachedBase;
      }
    }
  } catch {
    // fall through to the hardcoded base
  }
  cachedBase = FALLBACK_BASE;
  return cachedBase;
}

async function rdr<T>(
  path: string,
  init?: { method?: "GET" | "POST"; body?: unknown },
  retries = 3
): Promise<T> {
  const base = await getBaseUrl();
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(base + path, {
        method: init?.method ?? "GET",
        headers: {
          "User-Agent": UA,
          Accept: "application/json",
          ...(init?.body ? { "Content-Type": "application/json" } : {}),
        },
        body: init?.body ? JSON.stringify(init.body) : undefined,
      });
      // The backend throws sporadic 5xx / 429s under load; retry those.
      if (res.status >= 500 || res.status === 429) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      if (!res.ok) {
        throw new Error(`RDR ${path} -> HTTP ${res.status} ${res.statusText}`);
      }
      return (await res.json()) as T;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
  }
  throw new Error(`RDR ${path} failed after ${retries + 1} tries: ${String(lastErr)}`);
}

/** Full park catalog (~300 records, one call). */
export async function getAllPlaces(): Promise<CatalogPlace[]> {
  return rdr<CatalogPlace[]>("fd/places");
}

/** Full facility catalog (~500 records, one call). */
export async function getAllFacilities(): Promise<CatalogFacility[]> {
  return rdr<CatalogFacility[]>("fd/facilities");
}

/** Autocomplete parks by name. */
export async function searchParks(keyword: string): Promise<ParkMatch[]> {
  return rdr<ParkMatch[]>(
    `fd/citypark/namecontains/${encodeURIComponent(keyword)}`
  );
}

/** Expand a park (PlaceId) into its bookable facilities. */
export async function getFacilities(
  placeId: number,
  startDate: string
): Promise<FacilitySummary[]> {
  const body = {
    PlaceId: placeId,
    Latitude: 0,
    Longitude: 0,
    HighlightedPlaceId: 0,
    StartDate: startDate,
    Nights: 1,
    CountNearby: false,
    NearbyLimit: 0,
    NearbyOnlyAvailable: false,
    Sort: "Distance",
    CustomerId: 0,
    RefreshFavorites: false,
    IsADA: false,
    UnitCategoryId: 0,
    UnitTypesGroupIds: [],
    UnitTypeId: 0,
    SleepingUnitId: 0,
    MinVehicleLength: 0,
    IsEliminateEmptyNonADAResults: false,
  };
  const data = await rdr<SearchPlaceResponse>("search/place", {
    method: "POST",
    body,
  });
  const facilities = data.SelectedPlace?.Facilities ?? {};
  return Object.values(facilities).map((f) => ({
    FacilityId: f.FacilityId,
    Name: f.Name,
  }));
}

/**
 * Availability grid for a facility starting at `startDate`. One call returns
 * roughly three weeks of per-site slices regardless of `nights`.
 */
export async function getGrid(
  facilityId: number,
  startDate: string,
  nights = 1
): Promise<GridResponse> {
  return rdr<GridResponse>("search/grid", {
    method: "POST",
    body: {
      FacilityId: facilityId,
      StartDate: startDate,
      Nights: nights,
      IsADA: false,
      UnitCategoryId: "",
      SleepingUnitId: "",
      MinVehicleLength: "",
      UnitTypesGroupIds: [],
    },
  });
}
