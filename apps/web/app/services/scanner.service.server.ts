import { logger } from "~/lib/logger.server";
import { availabilityRepository } from "../repositories/availability.repository.server";
import { facilityRepository } from "../repositories/facility.repository.server";
import { HORIZON_DAYS } from "~/lib/limits";
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
 * It scans **every bookable campground**, not just watched ones. That makes scan
 * cost a function of the catalog (fixed, ~335) rather than of user count, which
 * only grows. Watched-only scanning costs more than this past ~170 watched
 * campgrounds, which is 10-20 users.
 *
 * It runs in the web app's process on purpose: the rate gate that keeps us
 * under ReserveCalifornia's limit is per-process state, so a second container
 * would get its own gate and silently double our request rate.
 */

/**
 * Freshness target for every bookable campground.
 *
 * Measured at 4.07s per campground — three gated calls plus network and the
 * slot write — so ~335 bookable campgrounds is a ~23 minute cycle. 25 leaves
 * room for a newly created watch without pushing the cycle over.
 */
const MAX_AGE_MS = 25 * 60 * 1000;
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
  /** Bookable campgrounds past their freshness target right now. */
  overdue: number;
  /** Worst staleness — the number that says whether we are keeping up. */
  oldestScan: string | null;
  /** How the catalog breaks down; only `bookable` is ever scanned. */
  byStatus: Record<string, number>;
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
    { action: "scanner.start", maxAgeMinutes: MAX_AGE_MS / 60000 },
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
  const [overdue, oldest, scannedLastHour, byStatus] = await Promise.all([
    facilityRepository.countOverdue({ scannedBefore: new Date(now - MAX_AGE_MS) }),
    facilityRepository.findOldestScan(),
    facilityRepository.countScannedSince(new Date(now - 60 * 60 * 1000)),
    facilityRepository.countByStatus(),
  ]);

  return {
    running: started,
    current,
    overdue,
    oldestScan: oldest?.lastScannedAt?.toISOString() ?? null,
    scannedLastHour,
    byStatus,
  };
}

/** The most overdue bookable campground, nulls (never scanned) first. */
async function pickNext() {
  return facilityRepository.findMostOverdue({ scannedBefore: new Date(Date.now() - MAX_AGE_MS) });
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
 * Drop slots outside the scanned window, on **both** sides.
 *
 * `replaceWindow` only rewrites the range it replaces, so anything outside it
 * is never updated and never removed. Past nights orphan at the near edge, and
 * shrinking the window to 63 days stranded ~985k rows at the far edge — a third
 * of them marked free, which search and the calendar would have shown as
 * current. The far-edge prune is not a one-off: every scan strands another day.
 *
 * Trend data lives in AvailabilityEvent, so dropping slots is not a loss.
 */
async function pruneIfDue(): Promise<void> {
  if (Date.now() - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = Date.now();

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const horizon = new Date(today);
  horizon.setDate(horizon.getDate() + HORIZON_DAYS);

  const [past, future] = await Promise.all([
    availabilityRepository.deleteSlotsBefore(today),
    availabilityRepository.deleteSlotsAfter(horizon),
  ]);
  if (past + future > 0) {
    logger.info({ action: "scanner.pruned", past, future }, "pruned slots outside the scanned window");
  }
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
