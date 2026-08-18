# CampingMeow — Project Spec

## 1. Purpose

CampingMeow helps people grab hard-to-get California state park campsites. Users pick campgrounds and date patterns they care about; we scan ReserveCalifornia and email them the moment a matching site opens up.

## 2. Requirements

1. **Catalog.** Sync all parks (~299) and campground facilities (~517) from ReserveCalifornia daily, including lat/long. Facilities that disappear from the API are marked inactive, never deleted — this doubles as our recovery path if IDs change.
2. **Browse.** Users can browse and search the catalog of parks and facilities.
3. **Watches.** A user creates a watch on one or more facilities (across any parks) with a shared date pattern: check-in weekdays, nights (1–7), and optional check-in date bounds. Example: "any Friday, 2 nights, June–August — at Moro Campground or San Mateo." Unbounded watches cover the full booking window and roll forward with it; a bounded watch whose end date has passed is auto-deactivated by the scanner.
4. **Scanning.** A background worker scans only watched facilities, on repeat, across the full 6-month booking window. When a watch is created for a facility not yet in rotation, that facility is scanned immediately so the user sees data right away.
5. **Availability state.** One row per (facility, unit, date) holding current availability, refreshed each scan. Rows for past dates are kept for future trending features.
5b. **Search with freshness.** Users can check availability for selected campgrounds and a date pattern without creating a watch. The page answers immediately from our database, then re-scans any campground last scanned more than **5 minutes** ago in the background, streaming each result back over server-sent events with a progress bar. Nobody waits on a refresh: results appear at once and improve as scans land. Closing the page stops the scans. A campground never scanned says so explicitly rather than reporting "nothing open"; one whose refresh fails says it is showing stored data.
6. **Notifications.** Email only (free-tier provider such as Resend). Sent when a slot flips unavailable → available and matches a watch. No repeat emails while the slot stays open. Email links to the facility's page on ReserveCalifornia.
7. **Politeness.** Delay between API calls (500ms baseline), back off on errors. We are a guest on an undocumented API.
8. **Monitoring.** Track sweep duration, emails sent per day, and number of watched facilities. If sweeps get slow we miss cancellations; if emails spike we hit provider limits. These metrics must be visible (admin panel) before we need them.
9. **Admin panel.** Admin-only page: list users, see each user's watches, remove/ban users, view the health metrics above, run a catalog sync, and start an availability sweep of either the watched campgrounds or the entire catalog (~500 campgrounds, ~1 hour). Sweeps run in the background with live progress.
10. **RBAC.** Two roles, `admin` and `user`, carried in Auth0 JWT claims and checked in the service layer (same pattern as auth today).
11. **Location search.** "Parks near me" by haversine distance on stored park lat/long. A typed address/city/ZIP is the primary input (geocoded server-side via OpenStreetMap Nominatim — free, throttled to 1 req/sec, cached); browser geolocation is a secondary option because VPNs make it unreliable.
12. **Branding.** CampingMeow favicon (replace the Bookshelf icon). Mascot: a cat in a Super Troopers hat asking if you want to go camping right meow.

## 3. Data model

- **User** — exists today (Auth0 sync). Add role.
- **Park** — RC place id, name, city, lat/long, active flag. Coordinates power distance search.
- **Facility** — RC facility id, name, parent park, active flag, `lastScannedAt` (null = never scanned). No lat/long: RC only has park-level coordinates.
- **Watch** — user, check-in weekdays, nights, optional date bounds, active flag.
- **WatchFacility** — join table: the facilities a watch covers (one pattern, many campgrounds).
- **AvailabilitySlot** — facility, unit id, unit name, date, `isFree`, updated timestamp. Unique per (facility, unit, date). Every night in the scanned window is stored, taken ones included, so a search can tell "booked" from "never scanned".
- **AvailabilityEvent** — append-only log of open/close transitions. Powers notification dedup, trending later, and the emails-per-day metric.
- **SweepRun** — when a sweep started/finished, facilities scanned, errors. Powers the sweep-duration metric.

## 4. Scanner design

- Runs as its own container on the Pi alongside the web app.
- Loop: load active watches → distinct facilities → grid-scan each (~13 calls per facility, 500ms apart) → upsert AvailabilitySlot → write AvailabilityEvent on transitions → record SweepRun → repeat.
- Watch creation triggers an immediate scan of that facility (~7 seconds).
- Rough budget: 10 watched facilities ≈ 130 calls ≈ 65 seconds per sweep. Full catalog would be ~56 minutes — that's why we scan watched-only.

## 5. Notifications

- On an unavailable → available event, find watches whose pattern matches the slot's facility, weekday, and (with consecutive open nights) night count.
- One email per matched watch per opening. No re-send while it stays open; if it closes and reopens, that's a new event and a new email.
- Email contains facility name, dates, and a link to ReserveCalifornia.

## 6. Out of scope (for now)

- SMS and push notifications.
- Hard limits on watches per user (monitored instead — revisit if metrics say so).
- Non-California sources.
- Trend charts (we keep the data; we don't build the UI yet).

## 7. Architecture conventions

Every feature follows the same layers, top to bottom. Each layer only talks to
the one directly below it.

1. **Routes** (`app/routes/`) — thin. Parse the request, call one service,
   return its result. No business logic, no Prisma.
2. **Services** (`app/services/`) — all business logic. Two flavors:
   - `<thing>Service` — a domain service owning one domain (catalog, watch,
     auth). Calls repositories.
   - `<thing>OrchestratorService` — coordinates multiple domain services for a
     cross-domain flow. Calls domain services, never repositories directly.
   Services return data already shaped for the UI — components never reshape.
3. **Repositories** (`app/repositories/`) — thin. Prisma queries only, one per
   entity, no business logic.
4. **UI components** — display only. Rendering logic is fine; business logic is
   not.

Supporting rules:

- Services are exported as named objects (`catalogService`, `authService`), one
  per file: `<thing>.service.server.ts`. Repositories likewise:
  `<thing>.repository.server.ts`. The `.server` suffix is load-bearing — it
  keeps the file out of the client bundle.
- `packages/scanner` is the data-access layer for the ReserveCalifornia API: a
  thin typed client, no business logic. It is to RC what repositories are to
  Postgres.
- **Pages never crash.** Every page route exports
  `ErrorBoundary` (re-export `PageErrorBoundary`), so a failure keeps the app
  shell and surfaces as a toast plus a recoverable inline message — never a
  bare fault page. Expected failures (validation) come back as data the form
  renders inline; unexpected ones become the toast. Services throw typed
  errors (`ValidationError`, `ForbiddenError`); routes translate them to
  responses.
- UI is built from shadcn-style components in `packages/ui`, which wrap Radix
  primitives (`radix-ui`). Never hand-roll a widget that Radix already
  provides (accordion, checkbox, radio group, dialog, tabs, tooltip, …) — add
  the shadcn wrapper to `packages/ui/src/components/` and use it. Hand-rolled
  interactive markup loses keyboard support, ARIA state, and focus management.
- Authorization checks live in the service layer, never in routes or
  repositories.
- **Slow work streams, it doesn't block.** Anything that takes more than a
  second or two answers from storage first and pushes updates over server-sent
  events (`text/event-stream` resource route). The domain service exposes it as
  an async generator taking an `AbortSignal`; the route only serialises frames.
  Each event carries a complete replacement snapshot, so the UI swaps state in
  rather than merging — the same "services return UI-ready shapes" rule. The
  signal must actually stop the work: a closed tab means nobody is waiting.

## 8. Implementation phases

1. **Catalog** — Park/Facility tables, daily sync job, browse/search UI, favicon.
2. **Watches** — Watch table, CRUD UI on facility pages, date-pattern form.
3. **Scanner** — worker container, AvailabilitySlot/Event/SweepRun, availability shown in UI, on-create scan.
4. **Notifications** — email provider setup, matching logic, dedup, deep links.
5. **Admin + RBAC** — roles in JWT, service-layer checks, admin panel with users/watches/metrics, ban.
6. **Location search** — geolocation, distance sort/filter.
7. **Polish** — mascot UX, empty states, trends if we feel like it.

Each phase ships behind the existing CI/CD pipeline with e2e coverage before moving on.
