import { prisma } from "@campingmeow/database";
import { splitName } from "../../app/lib/name";

export type CreateOwnerUserOverrides = {
  email?: string;
  name?: string;
  firstName?: string;
  lastName?: string | null;
};

export async function createOwnerUser(overrides: CreateOwnerUserOverrides = {}) {
  const name = overrides.name ?? "Owner User";
  const fallback = splitName(name);
  return prisma.user.create({
    data: {
      email: overrides.email ?? "owner@example.com",
      firstName: overrides.firstName ?? fallback.firstName,
      lastName: overrides.lastName !== undefined ? overrides.lastName : fallback.lastName,
    },
  });
}

export type CreateParkOverrides = {
  rcPlaceId?: number;
  name?: string;
  city?: string | null;
  active?: boolean;
  allowWebBooking?: boolean;
  /** Coordinates drive the distance filter; null (default) leaves a park unlocatable. */
  latitude?: number | null;
  longitude?: number | null;
};

let parkSeedCounter = 0;

export async function createPark(overrides: CreateParkOverrides = {}) {
  parkSeedCounter++;
  return prisma.park.create({
    data: {
      rcPlaceId: overrides.rcPlaceId ?? 100000 + parkSeedCounter,
      name: overrides.name ?? `Test Park ${parkSeedCounter}`,
      city: overrides.city !== undefined ? overrides.city : "Test City",
      active: overrides.active ?? true,
      allowWebBooking: overrides.allowWebBooking ?? true,
      latitude: overrides.latitude ?? null,
      longitude: overrides.longitude ?? null,
    },
  });
}

export type CreateFacilityOverrides = {
  rcFacilityId?: number;
  name?: string;
  facilityType?: number | null;
  active?: boolean;
  allowWebBooking?: boolean;
  parkId: string;
  /** Null (default) = never scanned; drives the "not scanned yet" / unscanned-callout UI on /search. */
  lastScannedAt?: Date | null;
  /** Only `bookable` campgrounds are scanned or offered in the watch picker. */
  status?: "bookable" | "no_inventory" | "first_come_first_served";
};

let facilitySeedCounter = 0;

export async function createFacility(overrides: CreateFacilityOverrides) {
  facilitySeedCounter++;
  return prisma.facility.create({
    data: {
      rcFacilityId: overrides.rcFacilityId ?? 200000 + facilitySeedCounter,
      name: overrides.name ?? `Test Facility ${facilitySeedCounter}`,
      facilityType: overrides.facilityType ?? null,
      active: overrides.active ?? true,
      allowWebBooking: overrides.allowWebBooking ?? true,
      parkId: overrides.parkId,
      lastScannedAt: overrides.lastScannedAt ?? null,
      status: overrides.status ?? "bookable",
    },
  });
}

export type CreateSlotsOverrides = {
  facilityId: string;
  /** All dates share one unit (campsite) unless you call this multiple times with different unitId/unitName. */
  unitId?: number;
  unitName?: string;
  dates: Date[];
  isFree?: boolean;
};

let slotUnitSeedCounter = 0;

/** Seeds one campsite's availability across several nights (e.g. seed a Fri + Sat free night for one site). */
export async function createSlots(overrides: CreateSlotsOverrides) {
  slotUnitSeedCounter++;
  const unitId = overrides.unitId ?? 300000 + slotUnitSeedCounter;
  const unitName = overrides.unitName ?? `Site ${slotUnitSeedCounter}`;
  return prisma.availabilitySlot.createMany({
    data: overrides.dates.map((date) => ({
      facilityId: overrides.facilityId,
      unitId,
      unitName,
      date,
      isFree: overrides.isFree ?? true,
    })),
  });
}

/**
 * Returns a UTC-midnight Date for the next occurrence of `weekday` (0=Sun..6=Sat) that is
 * at least `minDaysAhead` days out — matches the app's `@db.Date` / ISODate ("yyyy-MM-dd")
 * convention (see packages/scanner/src/dates.ts `parse`/`toDate`), and stays safely inside
 * the default 180-day search window without risking same-day timezone flakiness.
 */
export function nextWeekday(weekday: number, minDaysAhead = 3): Date {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  date.setUTCDate(date.getUTCDate() + minDaysAhead);
  const diff = (weekday - date.getUTCDay() + 7) % 7;
  date.setUTCDate(date.getUTCDate() + diff);
  return date;
}

/** yyyy-MM-dd for a UTC-midnight Date, matching packages/scanner's `fmt`. */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export type CreateWatchOverrides = {
  userId: string;
  /** One facility id, or several — a watch can cover multiple campgrounds. */
  facilityIds: string | string[];
  checkinDays?: number[];
  nights?: number;
  active?: boolean;
};

export async function createWatch(overrides: CreateWatchOverrides) {
  const facilityIds = Array.isArray(overrides.facilityIds) ? overrides.facilityIds : [overrides.facilityIds];
  return prisma.watch.create({
    data: {
      userId: overrides.userId,
      checkinDays: overrides.checkinDays ?? [5, 6],
      nights: overrides.nights ?? 1,
      active: overrides.active ?? true,
      facilities: { create: facilityIds.map((facilityId) => ({ facilityId })) },
    },
  });
}
