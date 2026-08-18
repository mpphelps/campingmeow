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

  for (const facility of watch.facilities) {
    void availabilityService.scanFacility(facility.facilityId).catch((err) => {
      logger.warn(
        { action: "watch.initial_scan_failed", facilityId: facility.facilityId, err },
        "initial scan after watch creation failed",
      );
    });
  }

  return watch;
}
