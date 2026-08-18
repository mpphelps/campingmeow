import { ForbiddenError, ValidationError } from "~/lib/errors";
import { logger } from "~/lib/logger.server";
import { facilityRepository } from "../repositories/facility.repository.server";
import { watchRepository } from "../repositories/watch.repository.server";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export interface WatchFacilityItem {
  facilityId: string;
  facilityName: string;
  parkId: string;
  parkName: string;
}

export interface WatchListItem {
  id: string;
  facilities: WatchFacilityItem[];
  /** e.g. ["Fri", "Sat"] */
  dayLabels: string[];
  nights: number;
  /** yyyy-MM-dd or null (null = full rolling booking window) */
  startDate: string | null;
  endDate: string | null;
  active: boolean;
}

export interface CreateWatchInput {
  facilityIds: string[];
  checkinDays: number[];
  nights: number;
  /** yyyy-MM-dd, empty/null = unbounded */
  startDate: string | null;
  endDate: string | null;
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

  const startDate = parseDateOrNull(input.startDate, "startDate", fields);
  const endDate = parseDateOrNull(input.endDate, "endDate", fields);
  if (startDate && endDate && endDate < startDate) {
    fields.endDate = "End date must be on or after the start date.";
  }

  const facilityIds = [...new Set(input.facilityIds)];
  if (facilityIds.length === 0) {
    fields.facilityIds = "Pick at least one campground.";
  } else {
    const facilities = await facilityRepository.listActiveByIds(facilityIds);
    if (facilities.length !== facilityIds.length) {
      fields.facilityIds = "One or more campgrounds are unknown.";
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
    startDate,
    endDate,
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
  startDate: Date | null;
  endDate: Date | null;
  active: boolean;
  facilities: {
    facility: { id: string; name: string; park: { id: string; name: string } };
  }[];
}): WatchListItem {
  return {
    id: watch.id,
    facilities: watch.facilities
      .map((wf) => ({
        facilityId: wf.facility.id,
        facilityName: wf.facility.name,
        parkId: wf.facility.park.id,
        parkName: wf.facility.park.name,
      }))
      .sort((a, b) => a.parkName.localeCompare(b.parkName) || a.facilityName.localeCompare(b.facilityName)),
    dayLabels: [...watch.checkinDays].sort().map((d) => DAY_LABELS[d]),
    nights: watch.nights,
    startDate: watch.startDate ? watch.startDate.toISOString().slice(0, 10) : null,
    endDate: watch.endDate ? watch.endDate.toISOString().slice(0, 10) : null,
    active: watch.active,
  };
}

function parseDateOrNull(value: string | null, field: string, fields: Record<string, string>): Date | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fields[field] = "Dates must be yyyy-MM-dd.";
    return null;
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    fields[field] = "Not a real date.";
    return null;
  }
  return date;
}
