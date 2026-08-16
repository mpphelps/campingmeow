# @campingmeow/scanner

Thin typed client for the **ReserveCalifornia** ("RDR") API. This package is
the data-access layer for RC — it fetches and assembles raw data and contains
**no business logic**. What counts as an "opening," what matches a watch, and
when to notify all live in app/worker domain services, not here.

See [`API.md`](./API.md) for how the (undocumented) API works.

## What it exposes

- `getAllPlaces()` / `getAllFacilities()` — the full park + campground catalog
  (one GET each; powers the daily catalog sync)
- `searchParks(keyword)` — name autocomplete
- `getFacilities(placeId, startDate)` — expand a park into bookable facilities
- `getGrid(facilityId, startDate)` — raw availability grid (~3 weeks per call)
- `fetchFacilityAvailability(facilityId, start, end, delayMs)` — pages the grid
  across a date range and merges slices into per-site free-night sets
- Date helpers (`addDays`, `dayOfWeek`, …) shared by callers

The API base URL is resolved at runtime from `reservecalifornia.com/config.json`
(with a hardcoded fallback), so the client survives RC host changes. Requests
retry on 5xx/429.

## CLI

```bash
npm run find -- "San Onofre"
```

Prints each matching park's `PlaceId` and the `FacilityId` of every campground
inside it. Handy for spot-checking IDs during development.

## Etiquette

- These endpoints are undocumented and can change without notice.
- Be polite: keep a delay between calls (500ms baseline) and back off on errors.
- Booking still happens on the official website; we only read availability.
