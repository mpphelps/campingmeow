// Thin typed client for the ReserveCalifornia ("RDR") backend.
// See API.md for endpoint documentation.

import { acquireSlot, drainQueue } from "./rate-limit.js";
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
/** Single-flight guard: see getBaseUrl. */
let baseInFlight: Promise<string> | null = null;

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
  // Point the client at a local stand-in. Only for load and leak testing — it
  // lets the real request path run (retries, error handling, body handling)
  // without touching ReserveCalifornia or waiting on its latency.
  const override = process.env.RC_BASE_URL;
  if (override) return override.endsWith("/") ? override : override + "/";
  if (cachedBase) return cachedBase;
  // Single-flight. On a cold start every queued scan calls this at once, and
  // without the guard each one fires its own config.json request — a burst at
  // reservecalifornia.com before we've made a single API call.
  baseInFlight ??= resolveBaseUrl().finally(() => {
    baseInFlight = null;
  });
  return baseInFlight;
}

async function resolveBaseUrl(): Promise<string> {
  // Same host family as the API, so it comes out of the same budget.
  await acquireSlot();
  try {
    const res = await fetch("https://reservecalifornia.com/config.json", {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      await discard(res);
    } else {
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

/**
 * How long to stand down after the API rate-limits us, when it doesn't say.
 * Observed penalties run from 15 minutes to several hours, so this is the
 * floor, not a guess at the real one.
 */
const DEFAULT_BLOCK_MS = 15 * 60 * 1000;

/**
 * Throw away a response body we are not going to read.
 *
 * Node's fetch does not free a response until its body is consumed or
 * cancelled: the buffered bytes stay reachable and the socket cannot go back
 * to the pool. Every error path here used to return without touching the body,
 * so each one leaked — quietly, and in proportion to how often the API failed.
 */
async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Already consumed or torn down; nothing to release.
  }
}

/**
 * Longest we will wait for one ReserveCalifornia response.
 *
 * Grid calls normally answer in well under two seconds, so this is not a
 * performance knob — it is the difference between a slow request and a scanner
 * that has silently stopped. A timeout surfaces as a connection failure and
 * takes the existing retry-with-backoff path.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Base backoff after a connection failure or 5xx, doubling per attempt.
 *
 * Overridable only so a local harness can drive thousands of failures through
 * this path without spending six seconds on each one. Leave it alone in
 * production: a struggling server needs more than the usual one-second gap.
 */
const RETRY_BACKOFF_MS = Number(process.env.RC_RETRY_BACKOFF_MS) || 2000;

/** Wall-clock time we're allowed to call again; 0 means we're not blocked. */
let blockedUntil = 0;

/**
 * Thrown when ReserveCalifornia has told us to back off. Distinct from an
 * ordinary failure: callers should abandon whatever batch they're doing rather
 * than move on to the next item, because every later call will fail too.
 */
export class RateLimitedError extends Error {
  readonly until: Date;
  constructor(until: Date) {
    super(`ReserveCalifornia rate-limited us; standing down until ${until.toISOString()}`);
    this.name = "RateLimitedError";
    this.until = until;
  }
}

/** Whether we're currently standing down, for the admin panel. */
export function getRateLimitState(): { blocked: boolean; until: string | null } {
  const blocked = Date.now() < blockedUntil;
  return { blocked, until: blocked ? new Date(blockedUntil).toISOString() : null };
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : at - Date.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function rdr<T>(
  path: string,
  init?: { method?: "GET" | "POST"; body?: unknown },
  retries = 3
): Promise<T> {
  if (Date.now() < blockedUntil) {
    throw new RateLimitedError(new Date(blockedUntil));
  }

  const base = await getBaseUrl();
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    // Every request — first try or retry — waits its turn at the global gate,
    // so concurrency can never raise the rate, only lengthen the queue.
    await acquireSlot();
    // The breaker may have tripped while we were queued behind someone else.
    if (Date.now() < blockedUntil) {
      throw new RateLimitedError(new Date(blockedUntil));
    }

    let res: Response;
    try {
      res = await fetch(base + path, {
        method: init?.method ?? "GET",
        headers: {
          "User-Agent": UA,
          Accept: "application/json",
          ...(init?.body ? { "Content-Type": "application/json" } : {}),
        },
        body: init?.body ? JSON.stringify(init.body) : undefined,
        // Without this a hung connection waits forever, and because the scanner
        // is one sequential loop, forever means the whole sweep stops — no
        // error, no cycle, nothing to see but a status that never changes.
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // Connection-level failure (DNS, reset, timeout) — worth another go.
      lastErr = err;
      // Extra backoff on top of the gate: a struggling server needs more than
      // the usual one-second gap.
      if (attempt < retries) await sleep(RETRY_BACKOFF_MS * 2 ** attempt);
      continue;
    }

    // Being told to go away. Retrying is exactly the wrong move — it deepens
    // the penalty — so trip a breaker that stops every caller, not just this
    // one, until the window passes.
    if (res.status === 429 || res.status === 403) {
      await discard(res);
      const wait = parseRetryAfter(res.headers.get("retry-after")) ?? DEFAULT_BLOCK_MS;
      blockedUntil = Date.now() + Math.max(wait, DEFAULT_BLOCK_MS);
      const blocked = new RateLimitedError(new Date(blockedUntil));
      // Anyone still queued would be refused too — fail them now rather than
      // trickling out doomed requests one per second.
      drainQueue(blocked);
      throw blocked;
    }

    // Sporadic 5xx under load; those really are transient.
    if (res.status >= 500) {
      await discard(res);
      lastErr = new Error(`HTTP ${res.status} ${res.statusText}`);
      if (attempt < retries) await sleep(RETRY_BACKOFF_MS * 2 ** attempt);
      continue;
    }

    // Any other 4xx is our bug — a bad id or a malformed body. Retrying it
    // just spends requests we can't afford.
    if (!res.ok) {
      await discard(res);
      throw new Error(`RDR ${path} -> HTTP ${res.status} ${res.statusText}`);
    }

    return (await res.json()) as T;
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
