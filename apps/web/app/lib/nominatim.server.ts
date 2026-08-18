// Thin client for OpenStreetMap's Nominatim geocoder (free, no API key).
// Data access only — no business logic. Their usage policy requires an
// identifying User-Agent and at most one request per second, so this module
// owns the throttle and a small cache.

const ENDPOINT = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "CampingMeow/0.1 (https://campingmeow.com)";
const MIN_INTERVAL_MS = 1100;
const CACHE_MAX = 500;

export interface GeocodeHit {
  latitude: number;
  longitude: number;
  label: string;
}

const cache = new Map<string, GeocodeHit | null>();
let lastRequestAt = 0;

export async function geocode(query: string): Promise<GeocodeHit | null> {
  const key = query.trim().toLowerCase();
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();

  const url = new URL(ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  url.searchParams.set("countrycodes", "us");

  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);

  const body = (await res.json()) as { lat: string; lon: string; display_name: string }[];
  const first = body[0];
  const hit: GeocodeHit | null = first
    ? { latitude: Number(first.lat), longitude: Number(first.lon), label: first.display_name }
    : null;

  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(key, hit);
  return hit;
}
