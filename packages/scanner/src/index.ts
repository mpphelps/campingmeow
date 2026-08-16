// @campingmeow/scanner — thin typed client for the ReserveCalifornia ("RDR")
// API. This package is the data-access layer for RC: it fetches and assembles
// raw availability/catalog data and nothing else. Business logic (what counts
// as an opening, what matches a watch) lives in app/worker domain services.

export {
  getBaseUrl,
  searchParks,
  getFacilities,
  getGrid,
  getAllPlaces,
  getAllFacilities,
} from "./api.js";

export {
  fetchFacilityAvailability,
  mergeGrid,
  type SiteAvailability,
  type FacilityAvailability,
} from "./availability.js";

export type {
  CatalogPlace,
  CatalogFacility,
  GridResponse,
  ParkMatch,
  FacilitySummary,
  Slice,
  Unit,
} from "./types.js";

export { addDays, eachDay, dayOfWeek, fmt, sliceKey, type ISODate, type DayName } from "./dates.js";
