import { getAllPlaces, getAllFacilities } from "@campingmeow/scanner";
import { logger } from "~/lib/logger.server";
import { parkRepository } from "../repositories/park.repository.server";
import { facilityRepository } from "../repositories/facility.repository.server";

export interface CatalogSyncResult {
  parksUpserted: number;
  parksDeactivated: number;
  facilitiesUpserted: number;
  facilitiesSkipped: number;
  facilitiesDeactivated: number;
}

// Domain service for the park/facility catalog.
export const catalogService = {
  sync,
};

/**
 * Pull the full ReserveCalifornia catalog and mirror it into our DB.
 * Records present are upserted (and reactivated); records that have
 * disappeared are marked inactive, never deleted.
 */
async function sync(): Promise<CatalogSyncResult> {
  logger.info({ action: "catalog.sync.start" }, "starting catalog sync");

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
