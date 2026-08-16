// Minimal typings for the ReserveCalifornia ("RDR") responses we use.
// See API.md for where these come from.

export interface ParkMatch {
  PlaceId: number;
  CityParkId: number;
  Name: string;
  Latitude: number;
  Longitude: number;
}

export interface FacilitySummary {
  FacilityId: number;
  Name: string;
}

export interface SearchPlaceResponse {
  SelectedPlace?: {
    PlaceId: number;
    Name: string;
    Facilities?: Record<string, { FacilityId: number; Name: string }>;
  };
}

// Full-catalog records from GET fd/places / fd/facilities. Both endpoints
// return many more fields; these are the ones we persist.
export interface CatalogPlace {
  PlaceId: number;
  Name: string;
  City: string | null;
  Latitude: number;
  Longitude: number;
  AllowWebBooking: boolean;
  IsWebViewable: boolean;
}

export interface CatalogFacility {
  FacilityId: number;
  PlaceId: number;
  Name: string;
  FacilityType: number;
  AllowWebBooking: boolean;
}

export interface Slice {
  Date: string; // "yyyy-MM-dd"
  IsFree: boolean;
  IsBlocked: boolean;
  IsWalkin: boolean;
  MinStay: number;
}

export interface Unit {
  UnitId: number;
  Name: string;
  ShortName: string;
  IsAda: boolean;
  AllowWebBooking: boolean;
  IsWebViewable: boolean;
  Slices: Record<string, Slice>; // key = "yyyy-MM-ddT00:00:00"
}

export interface GridResponse {
  Message: string;
  StartDate: string;
  EndDate: string;
  TodayDate: string;
  MinDate: string | null;
  MaxDate: string | null;
  Facility: {
    FacilityId: number;
    Name: string;
    Units: Record<string, Unit> | null;
  } | null;
}
