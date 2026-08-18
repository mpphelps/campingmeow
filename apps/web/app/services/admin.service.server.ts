import { authService, type AuthUser } from "./auth.service.server";
import { availabilityService, type SweepState } from "./availability.service.server";
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
  sweep: SweepState;
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
};

async function getDashboard(user: AuthUser): Promise<AdminDashboard> {
  authService.requirePermission(user, ADMIN_PERMISSION);

  const [userCount, parkCount, facilityCount, watchCount, watchedFacilityIds, users] = await Promise.all([
    userRepository.count(),
    parkRepository.countActive(),
    facilityRepository.countActive(),
    watchRepository.countActive(),
    watchRepository.listWatchedFacilityIds(),
    userRepository.listAllWithWatchCounts(),
  ]);

  return {
    stats: {
      userCount,
      parkCount,
      facilityCount,
      watchCount,
      watchedFacilityCount: watchedFacilityIds.length,
    },
    sweep: availabilityService.getSweepState(),
    users: users.map((u) => ({
      id: u.id,
      email: u.email,
      name: [u.firstName, u.lastName].filter(Boolean).join(" "),
      watchCount: u._count.watches,
      joined: u.createdAt.toISOString().slice(0, 10),
    })),
  };
}
