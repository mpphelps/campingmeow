import { addDays, fmt } from "@campingmeow/scanner";
import { ForbiddenError, ValidationError } from "~/lib/errors";
import { HORIZON_DAYS, MAX_WATCHES_PER_USER, MAX_WATCH_FACILITIES } from "~/lib/limits";
import { checkinLabel, isExpired, modeOf, toIsoDates, type WatchMode } from "~/lib/watch-schedule";
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
  mode: WatchMode;
  /** e.g. ["Fri", "Sat"] — empty for a dates watch. */
  dayLabels: string[];
  /** 0=Sun .. 6=Sat — what the availability calendar matches against. */
  checkinDays: number[];
  /** yyyy-MM-dd, ascending — empty for a pattern watch. */
  checkinDates: string[];
  /** "Fri Oct 16", one per check-in still ahead; empty for a pattern watch. */
  dateLabels: string[];
  nights: number;
  active: boolean;
  /** A dates watch whose every check-in has passed. Never true for a pattern. */
  expired: boolean;
}

export interface WatchInput {
  facilityIds: string[];
  mode: WatchMode;
  checkinDays: number[];
  /** yyyy-MM-dd */
  checkinDates: string[];
  nights: number;
}

/** Most check-in dates one watch can hold — ten weekends is plenty. */
export const MAX_CHECKIN_DATES = 10;

/** Values for the edit form, exactly as the create form would post them. */
export interface WatchFormValues {
  id: string;
  facilityIds: string[];
  mode: WatchMode;
  checkinDays: number[];
  checkinDates: string[];
  nights: number;
  expired: boolean;
}

// Domain service for watches: a user's subscriptions, each a weekday pattern or
// a set of specific check-in dates, covering one or more campgrounds.
export const watchService = {
  createWatch,
  updateWatch,
  getWatchForEdit,
  listWatchesForUser,
  setWatchPaused,
  deleteWatch,
};

/**
 * Check a watch's form, and work out what to store. Shared by create and edit,
 * so the two can never accept different things.
 *
 * `editingId` excludes the watch being edited from the per-user limit — editing
 * a watch must not be refused for being one too many.
 */
async function validate(
  userId: string,
  input: WatchInput,
  editingId: string | null,
): Promise<{ facilityIds: string[]; checkinDays: number[]; checkinDates: string[]; nights: number }> {
  const fields: Record<string, string> = {};
  const today = fmt(new Date());

  const nightsValid = Number.isInteger(input.nights) && input.nights >= 1 && input.nights <= 7;
  if (!nightsValid) fields.nights = "Nights must be between 1 and 7.";

  // A watch is one kind or the other; the unused half is stored empty.
  let checkinDays: number[] = [];
  let checkinDates: string[] = [];

  if (input.mode === "dates") {
    checkinDates = [...new Set(input.checkinDates)].sort();
    // Every night of the stay has to be one we scan, or we could never see it
    // open — so the latest check-in shrinks as the stay gets longer.
    const lastCheckin = addDays(today, HORIZON_DAYS - (nightsValid ? input.nights : 1) + 1);
    if (checkinDates.length === 0) {
      fields.checkinDates = "Pick at least one check-in date.";
    } else if (checkinDates.length > MAX_CHECKIN_DATES) {
      fields.checkinDates = `Pick at most ${MAX_CHECKIN_DATES} check-in dates.`;
    } else if (checkinDates.some((d) => !ISO_DATE.test(d))) {
      fields.checkinDates = "Check-in dates must be real dates.";
    } else if (checkinDates.some((d) => d < today)) {
      fields.checkinDates = "Check-in dates can't be in the past.";
    } else if (checkinDates.some((d) => d > lastCheckin)) {
      fields.checkinDates = `We only track the next ${HORIZON_DAYS} days, so the latest check-in we can watch for a ${input.nights}-night stay is ${lastCheckin}.`;
    }
  } else {
    checkinDays = [...new Set(input.checkinDays)].sort();
    if (checkinDays.length === 0) {
      fields.checkinDays = "Pick at least one check-in day.";
    } else if (checkinDays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      fields.checkinDays = "Check-in days must be days of the week.";
    }
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
    const live = await countLiveWatches(userId, editingId);
    if (live >= MAX_WATCHES_PER_USER) {
      fields.facilityIds = `You already have ${live} watches, which is the limit. Pause or delete one to make room.`;
    }
  }

  if (Object.keys(fields).length > 0) throw new ValidationError(fields);
  return { facilityIds, checkinDays, checkinDates, nights: input.nights };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Watches that can still send email: active, and not a dates watch whose every
 * check-in has passed. The limit exists to bound email volume, so a paused or
 * expired watch does not hold a slot.
 */
async function countLiveWatches(userId: string, excludeId: string | null): Promise<number> {
  const today = fmt(new Date());
  const watches = await watchRepository.listByUserId(userId);
  return watches.filter(
    (w) => w.id !== excludeId && w.active && !isExpired(toIsoDates(w.checkinDates), today),
  ).length;
}

async function createWatch(userId: string, input: WatchInput): Promise<WatchListItem> {
  const valid = await validate(userId, input, null);
  const watch = await watchRepository.create({
    userId,
    facilityIds: valid.facilityIds,
    checkinDays: valid.checkinDays,
    checkinDates: valid.checkinDates.map(toDate),
    nights: valid.nights,
  });
  logger.info(
    { action: "watch.create", watchId: watch.id, userId, facilityCount: valid.facilityIds.length, mode: input.mode },
    "watch created",
  );
  return toListItem(watch);
}

/**
 * Change an existing watch. This is how an expired dates watch comes back to
 * life — pick new check-ins — without rebuilding its list of campgrounds.
 *
 * Returns null when the watch does not exist; throws ForbiddenError on someone
 * else's watch.
 */
async function updateWatch(userId: string, watchId: string, input: WatchInput): Promise<WatchListItem | null> {
  const existing = await watchRepository.findById(watchId);
  if (!existing) return null;
  if (existing.userId !== userId) {
    logger.warn({ action: "watch.update_denied", watchId, userId }, "watch update denied");
    throw new ForbiddenError("Not your watch");
  }
  const valid = await validate(userId, input, watchId);
  const watch = await watchRepository.update(watchId, {
    facilityIds: valid.facilityIds,
    checkinDays: valid.checkinDays,
    checkinDates: valid.checkinDates.map(toDate),
    nights: valid.nights,
  });
  logger.info({ action: "watch.update", watchId, userId, mode: input.mode }, "watch updated");
  return toListItem(watch);
}

/** Null when it does not exist; throws ForbiddenError on someone else's watch. */
async function getWatchForEdit(userId: string, watchId: string): Promise<WatchFormValues | null> {
  const watch = await watchRepository.findByIdWithFacilities(watchId);
  if (!watch) return null;
  if (watch.userId !== userId) throw new ForbiddenError("Not your watch");
  const checkinDates = toIsoDates(watch.checkinDates);
  return {
    id: watch.id,
    facilityIds: watch.facilities.map((wf) => wf.facility.id),
    mode: modeOf({ checkinDays: watch.checkinDays, checkinDates }),
    checkinDays: [...watch.checkinDays].sort(),
    checkinDates,
    nights: watch.nights,
    expired: isExpired(checkinDates, fmt(new Date())),
  };
}

async function listWatchesForUser(userId: string): Promise<WatchListItem[]> {
  const watches = await watchRepository.listByUserId(userId);
  return watches.map(toListItem);
}

/**
 * Pause or resume one watch, without deleting it.
 *
 * The account-level email toggle silences everything at once; this is for "not
 * this one right now" — keeping a carefully built list of campgrounds and date
 * pattern while it is not wanted. The notifier already skips inactive watches,
 * so pausing is the only change needed.
 *
 * Returns false when the watch does not exist, so the route can 404 rather than
 * pretending something happened.
 */
async function setWatchPaused(userId: string, watchId: string, paused: boolean): Promise<boolean> {
  const watch = await watchRepository.findById(watchId);
  if (!watch) return false;
  if (watch.userId !== userId) {
    logger.warn({ action: "watch.pause_denied", watchId, userId }, "watch pause denied");
    throw new ForbiddenError("Not your watch");
  }
  await watchRepository.setActive(watchId, !paused);
  logger.info({ action: paused ? "watch.paused" : "watch.resumed", watchId, userId }, "watch pause changed");
  return true;
}

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
  checkinDates: Date[];
  nights: number;
  active: boolean;
  facilities: {
    facility: { id: string; name: string; siteCategories: number[]; park: { id: string; name: string } };
  }[];
}): WatchListItem {
  const checkinDates = toIsoDates(watch.checkinDates);
  const today = fmt(new Date());
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
    mode: modeOf({ checkinDays: watch.checkinDays, checkinDates }),
    dayLabels: [...watch.checkinDays].sort().map((d) => DAY_LABELS[d]),
    checkinDays: [...watch.checkinDays].sort(),
    checkinDates,
    // Only check-ins still ahead: a weekend that has passed is noise in the list.
    dateLabels: checkinDates.filter((d) => d >= today).map(checkinLabel),
    nights: watch.nights,
    active: watch.active,
    expired: isExpired(checkinDates, today),
  };
}

function toDate(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}
