import { logger } from "~/lib/logger.server";
import { availabilityRepository } from "../repositories/availability.repository.server";
import { facilityRepository } from "../repositories/facility.repository.server";
import { availabilityService } from "./availability.service.server";

/**
 * The scanner: one loop that repeatedly asks "what is most overdue?" and scans
 * it.
 *
 * There is deliberately **no job queue**. Scan work is derivable — it is a pure
 * function of `Facility.lastScannedAt` — so a queue would be a second, drifting
 * copy of state we already store. Working straight off `lastScannedAt` gives us
 * three things for free:
 *
 *  - **Crash recovery.** Campgrounds already scanned have a fresh timestamp and
 *    sort to the back, so a restart resumes exactly where it left off.
 *  - **Priority.** A newly watched campground has `lastScannedAt = null`, which
 *    sorts first, so it is picked next without a priority column.
 *  - **No collisions.** There are no discrete sweeps to overlap, so nothing has
 *    to be skipped or queued behind anything else.
 *
 * It runs in the web app's process on purpose: the rate gate that keeps us
 * under ReserveCalifornia's limit is per-process state, so a second container
 * would get its own gate and silently double our request rate.
 */

/** Watched campgrounds are the product — keep them fresh to the hour. */
const WATCHED_MAX_AGE_MS = 60 * 60 * 1000;
/** Everything else backs browse/search, where day-old data is honest and fine. */
const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Nothing overdue: wait before asking again. */
const IDLE_SLEEP_MS = 30_000;
/** After a failure, pause before the next pick so we don't spin on a bad row. */
const ERROR_SLEEP_MS = 60_000;
/** How often to drop slots for nights that have already passed. */
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface ScannerStatus {
  running: boolean;
  /** Campground currently being scanned, if any. */
  current: string | null;
  /** Campgrounds past their freshness target right now. */
  watchedOverdue: number;
  catalogOverdue: number;
  /** Worst staleness — the number that says whether we are keeping up. */
  oldestWatchedScan: string | null;
  oldestCatalogScan: string | null;
  /** Throughput over the last hour, derived from lastScannedAt. */
  scannedLastHour: number;
}

let started = false;
let current: string | null = null;
let lastPruneAt = 0;
/** Resolves the idle sleep early when new work appears. */
let wake: (() => void) | null = null;

export const scannerService = {
  start,
  nudge,
  getStatus,
};

function start(): void {
  if (started) return;
  if (process.env.DISABLE_SCANNER === "1") {
    logger.info({ action: "scanner.disabled" }, "scanner disabled by DISABLE_SCANNER");
    return;
  }
  started = true;
  logger.info(
    { action: "scanner.start", watchedMaxAgeMinutes: WATCHED_MAX_AGE_MS / 60000, catalogMaxAgeHours: CATALOG_MAX_AGE_MS / 3600000 },
    "scanner started",
  );
  void loop();
}

/**
 * Cut the idle wait short. Called when a watch is created so its campgrounds
 * are picked up in seconds rather than up to IDLE_SLEEP_MS later.
 */
function nudge(): void {
  wake?.();
}

async function getStatus(): Promise<ScannerStatus> {
  const now = Date.now();
  const [watchedOverdue, catalogOverdue, oldestWatched, oldestCatalog, scannedLastHour] = await Promise.all([
    facilityRepository.countOverdue({ watchedOnly: true, scannedBefore: new Date(now - WATCHED_MAX_AGE_MS) }),
    facilityRepository.countOverdue({ watchedOnly: false, scannedBefore: new Date(now - CATALOG_MAX_AGE_MS) }),
    facilityRepository.findOldestScan({ watchedOnly: true }),
    facilityRepository.findOldestScan({ watchedOnly: false }),
    facilityRepository.countScannedSince(new Date(now - 60 * 60 * 1000)),
  ]);

  return {
    running: started,
    current,
    watchedOverdue,
    catalogOverdue,
    oldestWatchedScan: oldestWatched?.lastScannedAt?.toISOString() ?? null,
    oldestCatalogScan: oldestCatalog?.lastScannedAt?.toISOString() ?? null,
    scannedLastHour,
  };
}

/**
 * Watched campgrounds first, then the rest of the catalog. Checking watched
 * work on every iteration is what removes the need for priorities: a watch
 * created during a catalog pass is picked up on the very next turn.
 */
async function pickNext() {
  const now = Date.now();
  const watched = await facilityRepository.findMostOverdue({
    watchedOnly: true,
    scannedBefore: new Date(now - WATCHED_MAX_AGE_MS),
  });
  if (watched) return watched;

  return facilityRepository.findMostOverdue({
    watchedOnly: false,
    scannedBefore: new Date(now - CATALOG_MAX_AGE_MS),
  });
}

async function loop(): Promise<void> {
  // Runs for the life of the process. Every error is contained per iteration so
  // one bad campground can never stop the scanner.
  for (;;) {
    try {
      await pruneIfDue();

      const facility = await pickNext();
      if (!facility) {
        await sleep(IDLE_SLEEP_MS);
        continue;
      }

      current = facility.name;
      // scanFacility writes lastScannedAt, which is what takes this campground
      // out of the overdue set — so a failure leaves it overdue and it will be
      // retried, but behind everything else that is also overdue.
      await availabilityService.scanFacility(facility.id);
    } catch (err) {
      logger.warn({ action: "scanner.iteration_failed", facility: current, err }, "scanner iteration failed");
      await sleep(ERROR_SLEEP_MS);
    } finally {
      current = null;
    }
  }
}

/**
 * Drop slots for nights that have already passed. `replaceWindow` only rewrites
 * today onward, so past dates orphan at roughly 25k rows/day across the
 * catalog. Done here rather than per scan because 500 no-op DELETEs a day is
 * waste; trend data lives in AvailabilityEvent, so this is not a loss.
 */
async function pruneIfDue(): Promise<void> {
  if (Date.now() - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = Date.now();

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const deleted = await availabilityRepository.deleteSlotsBefore(today);
  if (deleted > 0) logger.info({ action: "scanner.pruned", deleted }, "pruned past availability slots");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    wake = finish;

    function finish() {
      clearTimeout(timer);
      wake = null;
      resolve();
    }
  });
}
