import { logger } from "~/lib/logger.server";
import { availabilityService } from "./availability.service.server";
import { watchService, type CreateWatchInput, type WatchListItem } from "./watch.service.server";

// Coordinates the watch and availability domains. Per the layering rules this
// orchestrator only calls domain services, never repositories.
export const watchOrchestratorService = {
  createWatchAndScan,
};

/**
 * Create a watch, then start scanning its campgrounds so the user has data
 * to look at shortly. The scan runs in the background: it takes several
 * seconds per campground and the user shouldn't wait on it.
 */
async function createWatchAndScan(userId: string, input: CreateWatchInput): Promise<WatchListItem> {
  const watch = await watchService.createWatch(userId, input);
  void scanInBackground(watch.facilities.map((f) => f.facilityId));
  return watch;
}

/**
 * Scan the new watch's campgrounds one after another. The global rate gate
 * already stops parallel scans from raising the request rate, but firing all
 * 20 at once would interleave them in the queue — every campground would
 * finish at the end instead of the first finishing in ten seconds. Sequential
 * means results land steadily.
 */
async function scanInBackground(facilityIds: string[]): Promise<void> {
  for (const facilityId of facilityIds) {
    try {
      await availabilityService.scanFacility(facilityId);
    } catch (err) {
      logger.warn({ action: "watch.initial_scan_failed", facilityId, err }, "initial scan after watch creation failed");
    }
  }
}
