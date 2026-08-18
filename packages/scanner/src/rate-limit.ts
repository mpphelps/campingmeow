// One global gate every ReserveCalifornia request passes through.
//
// The rate has to be a property of the *process*, not of each caller. A
// per-loop delay (what we had) paces one scan but multiplies with concurrency:
// creating a watch on 20 campgrounds used to launch 20 self-paced loops and
// burst to ~20 req/s. Callers can no longer opt out or stack up — they queue.

/** Minimum gap between any two requests, process-wide. */
export const REQUEST_INTERVAL_MS = 1000;

/**
 * Most waiters we'll hold before refusing new work. At one release per second
 * this is also the worst-case wait in seconds, so it doubles as a promise to
 * whoever is queued: nobody sits behind more than a few minutes of backlog.
 */
const MAX_QUEUED = 200;

/** Thrown instead of queueing when the backlog is already at its cap. */
export class ScanQueueFullError extends Error {
  constructor(queued: number) {
    super(`ReserveCalifornia request queue is full (${queued} waiting); try again shortly`);
    this.name = "ScanQueueFullError";
  }
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
}

const queue: Waiter[] = [];
/** Earliest time the next request may go out. */
let nextSlotAt = 0;
let draining = false;

/** How many requests are waiting for a slot — surfaced in the admin panel. */
export function getQueueDepth(): number {
  return queue.length;
}

/**
 * Wait for permission to make one request. Resolves in FIFO order, at most one
 * per `REQUEST_INTERVAL_MS`.
 */
export function acquireSlot(): Promise<void> {
  if (queue.length >= MAX_QUEUED) {
    return Promise.reject(new ScanQueueFullError(queue.length));
  }
  return new Promise<void>((resolve, reject) => {
    queue.push({ resolve, reject });
    drain();
  });
}

/**
 * Fail everything still waiting. Used when the circuit breaker trips: those
 * requests would all be refused anyway, and holding them just delays the error
 * the caller needs to see.
 */
export function drainQueue(reason: Error): void {
  const waiting = queue.splice(0, queue.length);
  for (const waiter of waiting) waiter.reject(reason);
}

function drain(): void {
  if (draining) return;
  draining = true;

  void (async () => {
    while (queue.length > 0) {
      const wait = nextSlotAt - Date.now();
      if (wait > 0) await sleep(wait);

      const next = queue.shift();
      if (!next) break;
      // Reserve the slot before handing it over, so a caller that returns
      // synchronously can't jump the next one.
      nextSlotAt = Date.now() + REQUEST_INTERVAL_MS;
      next.resolve();
    }
    // Safe to clear: pushes are synchronous with their drain() call, so a
    // waiter added after this point restarts the loop itself.
    draining = false;
  })();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
