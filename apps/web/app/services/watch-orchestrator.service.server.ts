import { scannerService } from "./scanner.service.server";
import { watchService, type CreateWatchInput, type WatchListItem } from "./watch.service.server";

// Coordinates the watch and scanner domains. Per the layering rules this
// orchestrator only calls domain services, never repositories.
export const watchOrchestratorService = {
  createWatchAndScan,
};

/**
 * Create a watch and wake the scanner.
 *
 * There is nothing to schedule: a campground nobody has scanned has
 * `lastScannedAt = null`, which sorts first in the scanner's "most overdue"
 * pick, so the new watch's campgrounds are next in line by construction. The
 * nudge only saves the user waiting out the scanner's idle sleep.
 */
async function createWatchAndScan(userId: string, input: CreateWatchInput): Promise<WatchListItem> {
  const watch = await watchService.createWatch(userId, input);
  scannerService.nudge();
  return watch;
}
