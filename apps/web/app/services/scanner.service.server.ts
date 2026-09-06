import { HORIZON_DAYS } from "~/lib/limits";
import { logger } from "~/lib/logger.server";
import { availabilityRepository } from "../repositories/availability.repository.server";
import { facilityRepository } from "../repositories/facility.repository.server";
import { availabilityService } from "./availability.service.server";
import { notificationService } from "./notification.service.server";

/**
 * The scanner: sweep every bookable campground, then send the mail.
 *
 * ```
 * forever:
 *   prune nights outside the 63-day window
 *   scan every bookable campground   (writes slots and transition events)
 *   run the notifier                 (emails whatever those scans opened up)
 * ```
 *
 * It scans **everything bookable**, not just watched campgrounds. That makes
 * scan cost a function of the catalog (fixed, ~335) rather than of user count,
 * which only grows — and it is why there is no priority, no freshness target
 * and no queue here. Everything is scanned every pass, so "what is most
 * overdue" has no meaning.
 *
 * The notifier is called at the end of a pass rather than running its own loop:
 * a pass is exactly the unit of work that produces events, so there is nothing
 * to poll for. If ReserveCalifornia blocks us the sweep stops and mail stops
 * with it — deliberately. A 429 is an incident to fix, not a condition to route
 * around, and the admin panel says so loudly.
 *
 * It runs in the web app's process on purpose: the rate gate that keeps us
 * under ReserveCalifornia's limit is per-process state, so a second container
 * would get its own gate and silently double our request rate.
 */

/**
 * Only guards against a hot loop when there is nothing to scan. A pass with
 * work in it is paced by the rate gate to ~23 minutes regardless, so this is
 * not a tuning knob for cycle time.
 */
const IDLE_SLEEP_MS = 60_000;

export interface ScannerStatus {
  running: boolean;
  /** Campground currently being scanned, if any. */
  current: string | null;
  /** Which park it belongs to — a campground name alone is often ambiguous. */
  currentPark: string | null;
  /** Campgrounds finished so far this pass, and how many there are. */
  progress: number;
  progressTotal: number;
  /** Completed passes since start. */
  cycleNumber: number;
  lastCycleStartedAt: string | null;
  /** How long the last full pass took — the number that says if we keep up. */
  lastCycleDurationMs: number | null;
  lastCycleScanned: number;
  lastCycleFailed: number;
  /** How the catalog breaks down; only `bookable` is ever scanned. */
  byStatus: Record<string, number>;
}

let started = false;
let current: string | null = null;
let currentPark: string | null = null;
let progress = 0;
let progressTotal = 0;
let cycleNumber = 0;
let lastCycleStartedAt: number | null = null;
let lastCycleDurationMs: number | null = null;
let lastCycleScanned = 0;
let lastCycleFailed = 0;

export const scannerService = {
  start,
  getStatus,
};

function start(): void {
  if (started) return;
  if (process.env.DISABLE_SCANNER === "1") {
    logger.info({ action: "scanner.disabled" }, "scanner disabled by DISABLE_SCANNER");
    return;
  }
  started = true;
  logger.info({ action: "scanner.start", horizonDays: HORIZON_DAYS }, "scanner started");
  void loop();
}

async function getStatus(): Promise<ScannerStatus> {
  return {
    running: started,
    current,
    currentPark,
    progress,
    progressTotal,
    cycleNumber,
    lastCycleStartedAt: lastCycleStartedAt ? new Date(lastCycleStartedAt).toISOString() : null,
    lastCycleDurationMs,
    lastCycleScanned,
    lastCycleFailed,
    byStatus: await facilityRepository.countByStatus(),
  };
}

async function loop(): Promise<void> {
  // Runs for the life of the process. A pass is wrapped whole so one bad
  // campground can never stop the scanner.
  for (;;) {
    try {
      await runCycle();
    } catch (err) {
      logger.error({ action: "scanner.cycle_failed", err }, "scan cycle failed");
    }
    await sleep(IDLE_SLEEP_MS);
  }
}

async function runCycle(): Promise<void> {
  const startedAt = Date.now();
  lastCycleStartedAt = startedAt;

  await prune();

  const facilities = await facilityRepository.listBookable();
  let scanned = 0;
  let failed = 0;
  progress = 0;
  progressTotal = facilities.length;

  for (const facility of facilities) {
    current = facility.name;
    currentPark = facility.park.name;
    try {
      await availabilityService.scanFacility(facility.id);
      scanned++;
    } catch (err) {
      // Left for the next pass. A failure costs freshness, not correctness —
      // the stored window simply keeps the values it already had.
      logger.warn({ action: "scanner.facility_failed", facilityId: facility.id, err }, "facility scan failed");
      failed++;
    } finally {
      current = null;
      currentPark = null;
      progress++;
    }
  }

  cycleNumber++;
  lastCycleScanned = scanned;
  lastCycleFailed = failed;
  lastCycleDurationMs = Date.now() - startedAt;
  logger.info(
    { action: "scanner.cycle_complete", cycleNumber, scanned, failed, durationMs: lastCycleDurationMs },
    "scan cycle complete",
  );

  // The pass is what produces events, so this is the moment to send. Contained
  // separately: a mail problem must not stop the next sweep.
  try {
    const result = await notificationService.runOnce();
    if (result.emails > 0) logger.info({ action: "scanner.notified", ...result }, "notifier ran after cycle");
  } catch (err) {
    logger.error({ action: "scanner.notify_failed", err }, "notifier failed after cycle");
  }
}

/**
 * Drop nights outside the scanned window, on **both** sides.
 *
 * `replaceWindow` only deletes the range it replaces, so anything outside it is
 * never updated *and* never removed. Past nights orphan at the near edge, and
 * the far edge strands another day every time the window slides forward — which
 * is why this runs every pass rather than being a one-off cleanup.
 *
 * Trend data lives in AvailabilityEvent, so dropping slots is not a loss.
 */
async function prune(): Promise<void> {
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
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
