# ReserveCalifornia (UseDirect / "RDR") API notes

Everything here was verified live against the reservecalifornia.com backend on
2026-07-23. These are **undocumented, unofficial** endpoints — the same ones the
reservecalifornia.com single-page app calls from your browser. They can change
without notice. Treat this as a personal-use convenience, poll politely, and do
your actual booking on the official website.

---

## 1. Base URL (don't hardcode it)

The web app doesn't ship the API host in its code. On load it fetches a small
config file and reads `rdrApiUrl` from it:

```
GET https://reservecalifornia.com/config.json
```

Response (2026-07-23):

```json
{
  "rdrApiUrl": "https://california-rdr.prod.cali.rd12.recreation-management.tylerapp.com/rdr/",
  "rdApiUrl":  "https://rdapi.reservecalifornia.com/api/",
  "dateFormat": "MM/dd/yyyy",
  "apiDateFormat": "yyyy-MM-dd"
}
```

**`rdrApiUrl` is the base for every endpoint below.** The host moved from the old
`calirdr.usedirect.com` to a Tyler-hosted domain, which is exactly why old
scripts on the internet stopped working. Because the app resolves it at runtime,
the robust move is to fetch `config.json` yourself and use whatever it returns
(the client in this repo does this, then falls back to the hardcoded value).

All requests should send a normal browser `User-Agent`. JSON bodies need
`Content-Type: application/json`. No auth/API key is required for read/search.

Dates are `yyyy-MM-dd`. Slice keys come back as `yyyy-MM-ddT00:00:00`.

---

## 2. Autocomplete a park by name

```
GET {base}fd/citypark/namecontains/{keyword}
```

Example: `fd/citypark/namecontains/Crystal Cove` →

```json
[
  { "CityParkId": 634, "PlaceId": 634, "Name": "Crystal Cove SP Beach Cottages", ... },
  { "CityParkId": 635, "PlaceId": 635, "Name": "Crystal Cove SP Moro Campground", ... }
]
```

The `PlaceId` is what you feed into the place lookup below. A "place" is a park;
it contains one or more bookable "facilities" (individual campgrounds).

---

## 3. Place → facilities (get FacilityIds)

The availability grid is **per facility**, so you first expand a place into its
facilities:

```
POST {base}search/place
Content-Type: application/json

{
  "PlaceId": 635,
  "Latitude": 0, "Longitude": 0, "HighlightedPlaceId": 0,
  "StartDate": "2026-08-01", "Nights": 1,
  "CountNearby": false, "NearbyLimit": 0, "NearbyOnlyAvailable": false,
  "Sort": "Distance", "CustomerId": 0, "RefreshFavorites": false,
  "IsADA": false, "UnitCategoryId": 0, "UnitTypesGroupIds": [],
  "UnitTypeId": 0, "SleepingUnitId": 0, "MinVehicleLength": 0,
  "IsEliminateEmptyNonADAResults": false
}
```

Response → `SelectedPlace.Facilities` (an object keyed by FacilityId):

```
FacilityId 447  -> Moro Campground        (developed drive-in tent/RV sites)
FacilityId 2157 -> Deer Canyon            (primitive hike-in / environmental)
FacilityId 2158 -> Upper Moro Campground  (primitive hike-in / environmental)
FacilityId 2159 -> Lower Moro Campground  (primitive hike-in / environmental)
```

**For normal tent camping with a car you want FacilityId 447 (Moro Campground).**

> Note: sending a partial body here returns HTTP 500. Include the fields above.

---

## 4. Availability grid (the important one)

```
POST {base}search/grid
Content-Type: application/json

{
  "FacilityId": 447,
  "StartDate": "2026-08-01",
  "Nights": 1,
  "IsADA": false,
  "UnitCategoryId": "",
  "SleepingUnitId": "",
  "MinVehicleLength": "",
  "UnitTypesGroupIds": []
}
```

Key response fields:

```jsonc
{
  "Message": "",
  "StartDate": "2026-08-01",
  "EndDate":   "2026-08-21",   // one call returns ~3 weeks of slices, not just Nights
  "TodayDate": "2026-07-23",
  "MinDate":   "2026-07-24",   // earliest bookable date
  "MaxDate":   "2027-01-23",   // latest bookable date == rolling 6-month window
  "Facility": {
    "FacilityId": 447,
    "Name": "Moro Campground",
    "Units": {
      "40207": {
        "UnitId": 40207,
        "Name": "Premium Hook Up (E/W) Campsite #3",
        "IsAda": false,
        "AllowWebBooking": true,
        "IsWebViewable": true,
        "Slices": {
          "2026-08-01T00:00:00": {
            "Date": "2026-08-01",
            "IsFree": false,       // <-- true == this site is open that night
            "IsBlocked": false,
            "IsWalkin": false,
            "MinStay": 1,
            "ReservationId": 8492936
          }
          // ... one slice per date from StartDate..EndDate
        }
      }
      // ... ~50 units for Moro Campground
    }
  }
}
```

### How to read availability
- A **site (unit)** is open on a given night when
  `Unit.Slices["{date}T00:00:00"].IsFree === true`.
- Only consider sites you can actually book online:
  `AllowWebBooking === true && IsWebViewable === true`.
- For a multi-night stay, every night in the range must be `IsFree`.
- `MinStay` on a slice tells you the minimum nights required for a check-in on
  that date (usually 1, sometimes 2 on holiday weekends).

### Scanning a whole season
- One grid call returns **exactly 21 days** of slices (`StartDate` .. `StartDate+20`)
  for **all** sites in one facility. To cover the 6-month window you page and merge.
- `MinDate`/`MaxDate` in any grid response tell you the currently bookable range —
  use them to clamp your scan instead of guessing the 6-month math.
- Page by reading the last slice date in the response and starting the next call
  the day after. Don't hardcode a step: a fixed 14-day step re-fetches a third of
  every response, and would leave gaps if the 21-day cap ever changed.

#### The window cannot be widened (measured 2026-08-18)

| Attempt | Result |
|---|---|
| `Nights: 30` / `Nights: 180` | still 21 days |
| `EndDate` field in the body | ignored, still 21 days |
| `FacilityId: [447, 2157]` | HTTP 400 |
| `FacilityIds: [447, 2157]` | silently ignored — returns only `FacilityId` |
| `PlaceId` in place of `FacilityId` | empty response |
| `GET search/details/{placeId}/...` | HTTP 500 |

21 days × 1 facility is the hard ceiling on this endpoint. **9 calls** covers a
180-day window. The only way to widen coverage per request is `search/place`
(§3), which returns `Available: true/false` for *every* facility in a park in a
single call — no per-site or per-date detail, but a cheap change detector.

---

## 4b. Rate limits — the constraint everything else bends around

Reported thresholds (not officially published, treat as a working assumption):

- **Safe zone:** ≤ 1 request every 2–3 seconds.
- **Soft limit:** ~30–40 requests/minute trips a temporary block.
- **Penalty:** HTTP 429 or 403, and the IP or session is blacklisted for
  **15 minutes to several hours**.

On a single-IP deployment that penalty takes the whole app down, not just the
scan, so this package owns pacing for the whole process:

- **Global rate gate** (`rate-limit.ts`): every request — including the
  `config.json` base-URL lookup, and including retries — queues for a slot
  released once per second. A per-caller delay does not work: 20 concurrent
  scans each pacing themselves is 20 req/s. Callers cannot opt out; they queue.
- Backlog is capped (200 waiters); past that `ScanQueueFullError` is thrown
  rather than growing an unbounded queue.
- `getBaseUrl()` is single-flight, so a cold start with many queued scans makes
  one `config.json` request, not one per caller.

On top of that it trips a circuit breaker on the first 429/403 rather than
retrying:

- `RateLimitedError` is thrown, distinct from ordinary failures, so callers
  abandon the whole batch instead of moving to the next item.
- Every later call fails immediately without touching the network until the
  block expires (`Retry-After` if given, floor of 15 minutes).
- `getRateLimitState()` reports it for the admin panel.

- Tripping the breaker also drains the queue: everyone waiting would be
  refused anyway, so they fail immediately instead of trickling out doomed
  requests one per second.

Never retry a 429 — it deepens the penalty. Only 5xx and connection errors are
retried, with exponential backoff (on top of the gate's one-second spacing).

---

## 5. Other endpoints seen in the web app (not used here, for reference)

```
GET  {base}fd/places/{placeId}                         park metadata
GET  {base}fd/placeinfo/additional-place-info/{placeId} hours, max trailer length, etc.
GET  {base}fd/facilities/{facilityId}                  facility metadata
GET  {base}search/filters/{placeId}                    unit categories / equipment filters
GET  {base}search/next/{facilityId}/startdate/{date}/nights/{n}   next available date
GET  {base}search/details/{placeId}/startdate/{date}/nights/{n}/0/{n}
POST {base}search/grid                                 (time-based variant also exists)
```

---

## Crystal Cove quick reference

| Thing | Id |
|------|----|
| Park (PlaceId) — Crystal Cove SP Moro Campground | `635` |
| **Moro Campground (developed tent/RV) FacilityId** | **`447`** |
| Deer Canyon (hike-in) FacilityId | `2157` |
| Upper Moro (hike-in) FacilityId | `2158` |
| Lower Moro (hike-in) FacilityId | `2159` |
| Beach Cottages park (PlaceId) | `634` |

Book at: https://www.reservecalifornia.com/  → search "Crystal Cove SP Moro Campground".
