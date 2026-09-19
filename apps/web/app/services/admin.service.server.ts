import { ValidationError } from "~/lib/errors";
import { logger } from "~/lib/logger.server";
import { authService, type AuthUser } from "./auth.service.server";
import { availabilityService } from "./availability.service.server";
import { notificationService, type NotifierStatus } from "./notification.service.server";
import { scannerService, type ScannerStatus } from "./scanner.service.server";
import { emailLogRepository } from "../repositories/email-log.repository.server";
import { userRepository } from "../repositories/user.repository.server";
import { parkRepository } from "../repositories/park.repository.server";
import { facilityRepository } from "../repositories/facility.repository.server";
import { watchRepository } from "../repositories/watch.repository.server";

export const ADMIN_PERMISSION = "admin:site";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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
    /** Banned: reads as signed out everywhere, and gets no email. */
    banned: boolean;
    /** False when they have turned email off; their watches still run. */
    emailNotifications: boolean;
    /** Emails this account received in the trailing 24 hours, and in 7 days. */
    emailsLast24h: number;
    emailsLast7d: number;
    /** When we last mailed them, or null if never. */
    lastEmailedAt: string | null;
    /** What they are watching, so a support question can be answered here. */
    watches: {
      id: string;
      pattern: string;
      campgrounds: string[];
    }[];
    /** yyyy-MM-dd */
    joined: string;
  }[];
}

// Domain service for the admin panel.
export const adminService = {
  getDashboard,
  setScannerPaused,
  setUserBanned,
  recheckNonBookable,
};

/**
 * Re-scan the campgrounds we have marked unbookable.
 *
 * A campground is demoted the first time it reports nothing bookable, and
 * nothing promotes it back on its own — a site closed for winter stays closed
 * to us until someone asks. This is that ask.
 *
 * Manual on purpose. Self-healing is not built yet, and re-checking today's
 * window will not reveal a campground that only opens in summer. Both are
 * known gaps, written down rather than papered over.
 *
 * It lives here rather than in the availability service because it is an admin
 * action that happens to drive scans, and keeping it out of that service keeps
 * the scan path free of the auth import chain.
 */
async function recheckNonBookable(user: AuthUser): Promise<{ checked: number; nowBookable: string[] }> {
  authService.requirePermission(user, ADMIN_PERMISSION);
  const candidates = await facilityRepository.listNonBookable();
  logger.info({ action: "recheck.start", count: candidates.length, userId: user.id }, "re-checking non-bookable campgrounds");

  const nowBookable: string[] = [];
  for (const candidate of candidates) {
    try {
      const summary = await availabilityService.scanFacility(candidate.id);
      if (summary.status === "bookable") nowBookable.push(summary.facilityName);
    } catch (err) {
      logger.warn({ action: "recheck.failed", facilityId: candidate.id, err }, "re-check failed");
    }
  }

  logger.info({ action: "recheck.complete", checked: candidates.length, promoted: nowBookable.length }, "re-check complete");
  return { checked: candidates.length, nowBookable };
}

/**
 * Ban or unban an account.
 *
 * A ban makes the account read as signed out everywhere and stops its email;
 * nothing is deleted, so watches and preferences come back intact on an unban.
 */
async function setUserBanned(admin: AuthUser, userId: string, banned: boolean): Promise<{ banned: boolean }> {
  authService.requirePermission(admin, ADMIN_PERMISSION);
  // Banning yourself would lock you out of the page you would need to undo it.
  if (userId === admin.id) {
    throw new ValidationError({ userId: "You can't ban your own account." });
  }
  await userRepository.setBanned(userId, banned);
  logger.info({ action: banned ? "admin.user_banned" : "admin.user_unbanned", userId, by: admin.id }, "user ban changed");
  return { banned };
}

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
    userRepository.listAllWithDetail(),
    scannerService.getStatus(),
    notificationService.getStatus(),
  ]);

  // Who we mailed and when. The per-user breakdown lives in each batch's JSON,
  // so it is tallied here rather than queried — a week of batches is small.
  const week = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const batches = await emailLogRepository.listSince(week);
  const emailStats = new Map<string, { last24h: number; last7d: number; lastAt: Date }>();
  for (const batch of batches) {
    const recipients = (batch.metadata ?? {}) as Record<string, string[]>;
    for (const userId of Object.keys(recipients)) {
      const stat = emailStats.get(userId) ?? { last24h: 0, last7d: 0, lastAt: batch.sentAt };
      stat.last7d++;
      if (batch.sentAt.getTime() >= dayAgo) stat.last24h++;
      // Batches come back newest first, so the first one seen is the latest.
      if (batch.sentAt > stat.lastAt) stat.lastAt = batch.sentAt;
      emailStats.set(userId, stat);
    }
  }

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
      watchCount: u.watches.length,
      banned: u.bannedAt !== null,
      // No preference row yet means they have never changed it, and the
      // default is on.
      emailNotifications: u.preference?.emailNotifications ?? true,
      emailsLast24h: emailStats.get(u.id)?.last24h ?? 0,
      emailsLast7d: emailStats.get(u.id)?.last7d ?? 0,
      lastEmailedAt: emailStats.get(u.id)?.lastAt.toISOString() ?? null,
      watches: u.watches.map((watch) => ({
        id: watch.id,
        pattern: `${watch.checkinDays.map((d) => DAY_LABELS[d]).join(", ")} · ${watch.nights} night${watch.nights === 1 ? "" : "s"}`,
        campgrounds: watch.facilities.map((wf) => `${wf.facility.park.name} — ${wf.facility.name}`),
      })),
      joined: u.createdAt.toISOString().slice(0, 10),
    })),
  };
}
