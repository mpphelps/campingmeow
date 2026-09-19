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

/** Campgrounds between heap readings. Small enough to see a curve, quiet enough to read. */
const HEAP_LOG_EVERY = 10;

function logHeap(after: string): void {
  const mem = process.memoryUsage();
  logger.info(
    {
      action: "scanner.heap",
      progress,
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
      externalMb: Math.round(mem.external / 1024 / 1024),
      rssMb: Math.round(mem.rss / 1024 / 1024),
      after,
    },
    "heap",
  );
}

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
  /**
   * When a full pass last finished. Null until one does — which, while the
   * process was crashing mid-sweep, was the honest answer and the thing the
   * panel could not say.
   */
  lastCycleCompletedAt: string | null;
  /** How long the last full pass took — the number that says if we keep up. */
  lastCycleDurationMs: number | null;
  lastCycleScanned: number;
  lastCycleFailed: number;
  /** How the catalog breaks down; only `bookable` is ever scanned. */
  byStatus: Record<string, number>;
  /** Paused by an admin. The loop finishes its campground, then waits. */
  paused: boolean;
}

let started = false;
let paused = false;
/** Set while a cycle is in flight, cleared when one completes. Survives a pause. */
let cycleStartedAt: number | null = null;
let current: string | null = null;
let currentPark: string | null = null;
let progress = 0;
let progressTotal = 0;
let cycleNumber = 0;
let lastCycleStartedAt: number | null = null;
let lastCycleCompletedAt: number | null = null;
let lastCycleDurationMs: number | null = null;
let lastCycleScanned = 0;
let lastCycleFailed = 0;

export const scannerService = {
  start,
  getStatus,
  setPaused,
};

function start(): void {
  if (started) return;
  if (process.env.DISABLE_SCANNER === "1") {
    logger.info({ action: "scanner.disabled" }, "scanner disabled by DISABLE_SCANNER");
    return;
  }
  started = true;
  installCrashLogging();
  logger.info({ action: "scanner.start", horizonDays: HORIZON_DAYS }, "scanner started");
  void loop();
}

/**
 * Say something on the way down.
 *
 * Node exits on an unhandled rejection, and a server that vanishes mid-sweep
 * leaves a 502 and no explanation — which is exactly what happened. These
 * handlers do not prevent the exit; they make the next one diagnosable.
 */
let crashLoggingInstalled = false;
function installCrashLogging(): void {
  if (crashLoggingInstalled) return;
  crashLoggingInstalled = true;

  process.on("unhandledRejection", (reason) => {
    logger.error(
      { action: "process.unhandled_rejection", reason, current, currentPark, progress, progressTotal },
      "unhandled promise rejection",
    );
  });
  process.on("uncaughtException", (err) => {
    logger.error(
      { action: "process.uncaught_exception", err, current, currentPark, progress, progressTotal },
      "uncaught exception",
    );
  });
}

async function getStatus(): Promise<ScannerStatus> {
  return {
    running: started,
    paused,
    current,
    currentPark,
    progress,
    progressTotal,
    cycleNumber,
    lastCycleStartedAt: lastCycleStartedAt ? new Date(lastCycleStartedAt).toISOString() : null,
    lastCycleCompletedAt: lastCycleCompletedAt ? new Date(lastCycleCompletedAt).toISOString() : null,
    lastCycleDurationMs,
    lastCycleScanned,
    lastCycleFailed,
    byStatus: await facilityRepository.countByStatus(),
  };
}

/**
 * Stop or restart sweeping, without restarting the process.
 *
 * The scanner is the only thing here that talks to ReserveCalifornia and the
 * heaviest thing the box does, so when something is wrong this is the lever
 * that separates "the app is broken" from "the app is fine, the sweep isn't".
 * Pausing takes effect at the next campground rather than abandoning one
 * mid-write.
 */
function setPaused(next: boolean): void {
  if (paused === next) return;
  paused = next;
  logger.info({ action: next ? "scanner.paused" : "scanner.resumed" }, next ? "scanner paused" : "scanner resumed");
  // Resuming interrupts the idle sleep so work restarts now, not in a minute.
  if (!next) wake?.();
}

async function loop(): Promise<void> {
  // Runs for the life of the process. A pass is wrapped whole so one bad
  // campground can never stop the scanner.
  for (;;) {
    try {
      if (!paused) await runCycle();
    } catch (err) {
      logger.error({ action: "scanner.cycle_failed", err }, "scan cycle failed");
    }
    await sleep(IDLE_SLEEP_MS);
  }
}

async function runCycle(): Promise<void> {
  // A cycle in flight keeps its start time across pauses and restarts. That
  // timestamp is the whole resume mechanism: anything scanned since it began
  // is already done, so the work left is derivable rather than remembered.
  const resuming = cycleStartedAt !== null;
  if (!resuming) {
    cycleStartedAt = Date.now();
    lastCycleStartedAt = cycleStartedAt;
    // Only on a fresh cycle. Re-pruning on every resume would be wasted work.
    await prune();
  }
  const startedAt = cycleStartedAt!;

  const facilities = await facilityRepository.listBookable();
  const pending = resuming
    ? facilities.filter((f) => !f.lastScannedAt || f.lastScannedAt.getTime() < startedAt)
    : facilities;

  progressTotal = facilities.length;
  progress = facilities.length - pending.length;
  if (resuming) {
    logger.info({ action: "scanner.cycle_resumed", progress, progressTotal }, "resuming cycle where it stopped");
  }

  let scanned = 0;
  let failed = 0;
  let emailedDuringCycle = 0;

  for (const facility of pending) {
    // Checked per campground rather than per cycle: a sweep takes half an hour,
    // and a pause that waits half an hour is not a pause.
    if (paused) {
      logger.info({ action: "scanner.pause_break", progress, progressTotal }, "paused mid-cycle");
      // Deliberately leaves cycleStartedAt set and returns without completing:
      // a half-swept catalog is not a cycle, and counting it as one would put
      // a fictional duration on the admin panel.
      return;
    }
    current = facility.name;
    currentPark = facility.park.name;
    try {
      const summary = await availabilityService.scanFacility(facility.id);
      scanned++;

      // Tell people now rather than at the end of the sweep. A pass takes
      // around 24 minutes, so an opening found early would otherwise be
      // announced twenty minutes late — long enough to lose a cancellation.
      // Only the first opening per person goes out this way; the notifier
      // batches the rest at the end of the pass.
      if (summary.opened > 0) {
        try {
          const result = await notificationService.notifyFacility(facility.id);
          if (result.emails > 0) {
            emailedDuringCycle += result.emails;
            logger.info(
              { action: "scanner.notified_immediately", facilityId: facility.id, emails: result.emails },
              "emailed watchers as soon as the opening was found",
            );
          }
        } catch (err) {
          // Contained: mail is not worth abandoning the sweep for, and the
          // end-of-pass run picks up whatever did not go out.
          logger.warn({ action: "scanner.immediate_notify_failed", facilityId: facility.id, err }, "immediate notify failed");
        }
      }
    } catch (err) {
      // Left for the next pass. A failure costs freshness, not correctness —
      // the stored window simply keeps the values it already had.
      logger.warn({ action: "scanner.facility_failed", facilityId: facility.id, err }, "facility scan failed");
      failed++;
    } finally {
      current = null;
      currentPark = null;
      progress++;
      // Per campground, not per cycle. A cycle takes 40 minutes and the process
      // dies before finishing one, so cycle-end logging never got to run — this
      // is the growth curve we actually need: flat means the leak is elsewhere,
      // a steady climb means we retain something per scan, a step means one
      // campground allocates enormously.
      if (progress % HEAP_LOG_EVERY === 0) logHeap(facility.name);
    }
  }

  cycleNumber++;
  lastCycleScanned = scanned;
  lastCycleFailed = failed;
  lastCycleCompletedAt = Date.now();
  lastCycleDurationMs = lastCycleCompletedAt - startedAt;
  cycleStartedAt = null;

  const heap = process.memoryUsage();
  logger.info(
    {
      action: "scanner.cycle_complete",
      cycleNumber,
      scanned,
      failed,
      durationMs: lastCycleDurationMs,
      heapUsedMb: Math.round(heap.heapUsed / 1024 / 1024),
      rssMb: Math.round(heap.rss / 1024 / 1024),
    },
    "scan cycle complete",
  );

  // The pass is what produces events, so this is the moment to send. Contained
  // separately: a mail problem must not stop the next sweep.
  try {
    const result = await notificationService.runOnce();
    if (result.emails > 0 || emailedDuringCycle > 0) {
      logger.info({ action: "scanner.notified", ...result, emailedDuringCycle }, "notifier ran after cycle");
    }
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

/**
 * Sleep that can be cut short.
 *
 * Without this, resuming waits out the full idle sleep before anything
 * happens — a pause that takes effect in seconds but a resume that takes a
 * minute, which reads as a broken button rather than a slow one.
 */
let wake: (() => void) | null = null;

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
