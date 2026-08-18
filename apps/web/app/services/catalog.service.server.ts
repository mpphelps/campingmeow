import { getAllPlaces, getAllFacilities } from "@campingmeow/scanner";
import { logger } from "~/lib/logger.server";
import { parkRepository } from "../repositories/park.repository.server";
import { facilityRepository } from "../repositories/facility.repository.server";
import { authService, type AuthUser } from "./auth.service.server";
import { ADMIN_PERMISSION } from "./admin.service.server";

export interface CatalogSyncResult {
  parksUpserted: number;
  parksDeactivated: number;
  facilitiesUpserted: number;
  facilitiesSkipped: number;
  facilitiesDeactivated: number;
}

export interface ParkListItem {
  id: string;
  name: string;
  city: string | null;
  facilityCount: number;
}

export interface ParkDetail {
  id: string;
  name: string;
  city: string | null;
  facilities: { id: string; name: string }[];
}

export interface FacilityDetail {
  id: string;
  name: string;
  parkId: string;
  parkName: string;
}

export interface FacilityPickerItem {
  id: string;
  name: string;
  parkName: string;
}

export interface ParkBrowseItem {
  id: string;
  name: string;
  city: string | null;
  /** Null when ReserveCalifornia has no coordinates; excluded from distance filtering. */
  latitude: number | null;
  longitude: number | null;
  facilities: { id: string; name: string }[];
}

// Domain service for the park/facility catalog.
export const catalogService = {
  sync,
  listParks,
  listParksWithFacilities,
  getParkDetail,
  getFacilityDetail,
  listFacilityPicker,
};

/**
 * Every active park with its active facilities inline, for the browse
 * accordion. The whole catalog ships to the client so name and distance
 * filtering happen instantly as the user types.
 */
async function listParksWithFacilities(): Promise<ParkBrowseItem[]> {
  const parks = await parkRepository.searchActiveWithFacilities(null);
  return parks.map((park) => ({
    id: park.id,
    name: park.name,
    city: park.city,
    latitude: park.latitude,
    longitude: park.longitude,
    facilities: park.facilities.map((f) => ({ id: f.id, name: f.name })),
  }));
}

/**
 * Active facilities with park names for the watch-form picker, optionally
 * limited to specific parks or facilities.
 */
async function listFacilityPicker(filter?: { parkIds?: string[]; facilityIds?: string[] }): Promise<FacilityPickerItem[]> {
  const facilities = await facilityRepository.listActiveWithPark(filter);
  return facilities
    .map((f) => ({ id: f.id, name: f.name, parkName: f.park.name }))
    .sort((a, b) => a.parkName.localeCompare(b.parkName) || a.name.localeCompare(b.name));
}

/** One active facility with its park, or null. */
async function getFacilityDetail(facilityId: string): Promise<FacilityDetail | null> {
  const facility = await facilityRepository.findById(facilityId);
  if (!facility || !facility.active) return null;
  return {
    id: facility.id,
    name: facility.name,
    parkId: facility.park.id,
    parkName: facility.park.name,
  };
}

/** Active parks, optionally filtered by name/city, shaped for the browse page. */
async function listParks(query: string | null): Promise<ParkListItem[]> {
  const parks = await parkRepository.searchActive(query);
  return parks.map((park) => ({
    id: park.id,
    name: park.name,
    city: park.city,
    facilityCount: park._count.facilities,
  }));
}

/** One park with its active facilities, or null if unknown/inactive. */
async function getParkDetail(parkId: string): Promise<ParkDetail | null> {
  const park = await parkRepository.findById(parkId);
  if (!park || !park.active) return null;
  const facilities = await facilityRepository.listActiveByParkId(park.id);
  return {
    id: park.id,
    name: park.name,
    city: park.city,
    facilities: facilities.map((f) => ({ id: f.id, name: f.name })),
  };
}

/**
 * Pull the full ReserveCalifornia catalog and mirror it into our DB.
 * Records present are upserted (and reactivated); records that have
 * disappeared are marked inactive, never deleted. Admin-only.
 */
async function sync(user: AuthUser): Promise<CatalogSyncResult> {
  authService.requirePermission(user, ADMIN_PERMISSION);
  logger.info({ action: "catalog.sync.start", userId: user.id }, "starting catalog sync");

  const places = await getAllPlaces();
  await new Promise((r) => setTimeout(r, 500)); // politeness delay between calls
  const facilities = await getAllFacilities();

  // RC uses (0,0) for "no coordinates" — store null instead.
  const parkIdByRcPlaceId = new Map<number, string>();
  for (const place of places) {
    const hasCoords = place.Latitude !== 0 || place.Longitude !== 0;
    const park = await parkRepository.upsertByRcPlaceId({
      rcPlaceId: place.PlaceId,
      name: place.Name,
      city: place.City ?? null,
      latitude: hasCoords ? place.Latitude : null,
      longitude: hasCoords ? place.Longitude : null,
      allowWebBooking: place.AllowWebBooking,
    });
    parkIdByRcPlaceId.set(place.PlaceId, park.id);
  }
  const parksDeactivated = await parkRepository.deactivateMissing(places.map((p) => p.PlaceId));

  let facilitiesUpserted = 0;
  let facilitiesSkipped = 0;
  for (const facility of facilities) {
    const parkId = parkIdByRcPlaceId.get(facility.PlaceId);
    if (!parkId) {
      // Facility references a place not in the catalog; skip rather than invent a park.
      facilitiesSkipped++;
      continue;
    }
    await facilityRepository.upsertByRcFacilityId({
      rcFacilityId: facility.FacilityId,
      name: facility.Name,
      facilityType: facility.FacilityType ?? null,
      allowWebBooking: facility.AllowWebBooking,
      parkId,
    });
    facilitiesUpserted++;
  }
  const facilitiesDeactivated = await facilityRepository.deactivateMissing(
    facilities.map((f) => f.FacilityId),
  );

  const result: CatalogSyncResult = {
    parksUpserted: places.length,
    parksDeactivated,
    facilitiesUpserted,
    facilitiesSkipped,
    facilitiesDeactivated,
  };
  logger.info({ action: "catalog.sync.complete", ...result }, "catalog sync complete");
  return result;
}
