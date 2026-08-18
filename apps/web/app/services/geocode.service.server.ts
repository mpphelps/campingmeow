import { ValidationError } from "~/lib/errors";
import { logger } from "~/lib/logger.server";
import { geocode, type GeocodeHit } from "~/lib/nominatim.server";

export interface GeocodeResult {
  latitude: number;
  longitude: number;
  /** Short, human-readable version of what we matched. */
  label: string;
}

// Domain service for turning a typed place into coordinates.
export const geocodeService = {
  lookup,
};

async function lookup(query: string | null): Promise<GeocodeResult | null> {
  const trimmed = (query ?? "").trim();
  if (trimmed.length < 3) {
    throw new ValidationError({ location: "Enter a city, ZIP, or address." });
  }

  let hit: GeocodeHit | null;
  try {
    hit = await geocode(trimmed);
  } catch (err) {
    logger.warn({ action: "geocode.failed", err }, "geocoder unavailable");
    throw new Error("Geocoder unavailable");
  }
  if (!hit) return null;

  return { latitude: hit.latitude, longitude: hit.longitude, label: shorten(hit.label) };
}

/** Nominatim returns a long comma-joined name; the first few parts are enough. */
function shorten(label: string): string {
  return label.split(",").slice(0, 3).join(",").trim();
}
