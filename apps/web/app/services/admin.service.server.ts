import { authService, type AuthUser } from "./auth.service.server";
import { availabilityService } from "./availability.service.server";
import { notificationService, type NotifierStatus } from "./notification.service.server";
import { scannerService, type ScannerStatus } from "./scanner.service.server";
import { userRepository } from "../repositories/user.repository.server";
import { parkRepository } from "../repositories/park.repository.server";
import { facilityRepository } from "../repositories/facility.repository.server";
import { watchRepository } from "../repositories/watch.repository.server";

export const ADMIN_PERMISSION = "admin:site";

export interface AdminDashboard {
  stats: {
    userCount: number;
    parkCount: number;
    facilityCount: number;
    watchCount: number;
    watchedFacilityCount: number;
  };
  scanner: ScannerStatus;
  notifier: NotifierStatus;
  /** Set while ReserveCalifornia has us blocked; nothing will scan until it clears. */
  rateLimit: { blocked: boolean; until: string | null };
  /** ReserveCalifornia requests waiting at the global rate gate. */
  queueDepth: number;

  users: {
    id: string;
    email: string;
    name: string;
    watchCount: number;
    /** yyyy-MM-dd */
    joined: string;
  }[];
}

// Domain service for the admin panel.
export const adminService = {
  getDashboard,
  setScannerPaused,
};

/**
 * Stop or restart the sweep. Admin-only, and checked here rather than in the
 * route, like every other permission in the app.
 */
function setScannerPaused(user: AuthUser, paused: boolean): { paused: boolean } {
  authService.requirePermission(user, ADMIN_PERMISSION);
  scannerService.setPaused(paused);
  return { paused };
}

async function getDashboard(user: AuthUser): Promise<AdminDashboard> {
  authService.requirePermission(user, ADMIN_PERMISSION);

  const [userCount, parkCount, facilityCount, watchCount, watchedFacilityIds, users, scanner, notifier] = await Promise.all([
    userRepository.count(),
    parkRepository.countActive(),
    facilityRepository.countActive(),
    watchRepository.countActive(),
    watchRepository.listWatchedFacilityIds(),
    userRepository.listAllWithWatchCounts(),
    scannerService.getStatus(),
    notificationService.getStatus(),
  ]);

  return {
    stats: {
      userCount,
      parkCount,
      facilityCount,
      watchCount,
      watchedFacilityCount: watchedFacilityIds.length,
    },
    scanner,
    notifier,
    rateLimit: availabilityService.getRateLimitState(),
    queueDepth: availabilityService.getQueueDepth(),
    users: users.map((u) => ({
      id: u.id,
      email: u.email,
      name: [u.firstName, u.lastName].filter(Boolean).join(" "),
      watchCount: u._count.watches,
      joined: u.createdAt.toISOString().slice(0, 10),
    })),
  };
}
