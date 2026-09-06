import { ForbiddenError, ValidationError } from "~/lib/errors";
import { MAX_WATCHES_PER_USER, MAX_WATCH_FACILITIES } from "~/lib/limits";
import { logger } from "~/lib/logger.server";
import { facilityRepository } from "../repositories/facility.repository.server";
import { toSiteTypes, type SiteType } from "~/lib/site-types";
import { watchRepository } from "../repositories/watch.repository.server";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export interface WatchFacilityItem {
  facilityId: string;
  facilityName: string;
  parkId: string;
  parkName: string;
  siteTypes: SiteType[];
}

export interface WatchListItem {
  id: string;
  facilities: WatchFacilityItem[];
  /** e.g. ["Fri", "Sat"] */
  dayLabels: string[];
  /** 0=Sun .. 6=Sat — what the availability calendar matches against. */
  checkinDays: number[];
  nights: number;
  active: boolean;
}

export interface CreateWatchInput {
  facilityIds: string[];
  checkinDays: number[];
  nights: number;
}

// Domain service for watches: a user's date-pattern subscriptions, each
// covering one or more campgrounds.
export const watchService = {
  createWatch,
  listWatchesForUser,
  deleteWatch,
};

async function createWatch(userId: string, input: CreateWatchInput): Promise<WatchListItem> {
  const fields: Record<string, string> = {};

  const checkinDays = [...new Set(input.checkinDays)].sort();
  if (checkinDays.length === 0) {
    fields.checkinDays = "Pick at least one check-in day.";
  } else if (checkinDays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    fields.checkinDays = "Check-in days must be days of the week.";
  }

  if (!Number.isInteger(input.nights) || input.nights < 1 || input.nights > 7) {
    fields.nights = "Nights must be between 1 and 7.";
  }

  const facilityIds = [...new Set(input.facilityIds)];
  if (facilityIds.length === 0) {
    fields.facilityIds = "Pick at least one campground.";
  } else if (facilityIds.length > MAX_WATCH_FACILITIES) {
    fields.facilityIds = `A watch can cover at most ${MAX_WATCH_FACILITIES} campgrounds (you picked ${facilityIds.length}). Create a second watch for the rest.`;
  } else {
    const facilities = await facilityRepository.listActiveByIds(facilityIds);
    if (facilities.length !== facilityIds.length) {
      fields.facilityIds = "One or more campgrounds are unknown.";
    } else {
      // A watch on these could never fire: nothing is reservable, so no
      // cancellation can happen. Checked here too, not just in the picker,
      // because the form posts ids.
      const unwatchable = facilities.filter((f) => f.status !== "bookable");
      if (unwatchable.length > 0) {
        fields.facilityIds = `${unwatchable
          .map((f) => f.name)
          .join(", ")} can't be watched — sites there aren't reservable online, so nothing can open up.`;
      }
    }
  }

  // Checked last so a user at the cap still sees any other problems with the
  // form, rather than fixing them one round-trip at a time.
  if (Object.keys(fields).length === 0) {
    const existing = await watchRepository.countActiveByUserId(userId);
    if (existing >= MAX_WATCHES_PER_USER) {
      fields.facilityIds = `You already have ${existing} watches, which is the limit. Delete one to make room.`;
    }
  }

  if (Object.keys(fields).length > 0) {
    throw new ValidationError(fields);
  }

  const watch = await watchRepository.create({
    userId,
    facilityIds,
    checkinDays,
    nights: input.nights,
  });
  logger.info(
    { action: "watch.create", watchId: watch.id, userId, facilityCount: facilityIds.length },
    "watch created",
  );
  return toListItem(watch);
}

async function listWatchesForUser(userId: string): Promise<WatchListItem[]> {
  const watches = await watchRepository.listByUserId(userId);
  return watches.map(toListItem);
}

/** Returns false if the watch doesn't exist. Throws if it belongs to someone else. */
async function deleteWatch(userId: string, watchId: string): Promise<boolean> {
  const watch = await watchRepository.findById(watchId);
  if (!watch) return false;
  if (watch.userId !== userId) {
    logger.warn({ action: "watch.delete_denied", watchId, userId }, "watch delete denied");
    throw new ForbiddenError("Not your watch");
  }
  await watchRepository.delete(watchId);
  logger.info({ action: "watch.delete", watchId, userId }, "watch deleted");
  return true;
}

function toListItem(watch: {
  id: string;
  checkinDays: number[];
  nights: number;
  active: boolean;
  facilities: {
    facility: { id: string; name: string; siteCategories: number[]; park: { id: string; name: string } };
  }[];
}): WatchListItem {
  return {
    id: watch.id,
    facilities: watch.facilities
      .map((wf) => ({
        facilityId: wf.facility.id,
        facilityName: wf.facility.name,
        siteTypes: toSiteTypes(wf.facility.siteCategories),
        parkId: wf.facility.park.id,
        parkName: wf.facility.park.name,
      }))
      .sort((a, b) => a.parkName.localeCompare(b.parkName) || a.facilityName.localeCompare(b.facilityName)),
    dayLabels: [...watch.checkinDays].sort().map((d) => DAY_LABELS[d]),
    checkinDays: [...watch.checkinDays].sort(),
    nights: watch.nights,
    active: watch.active,
  };
}

