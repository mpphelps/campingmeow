# CampingMeow — Project Spec

## 1. Purpose

CampingMeow helps people grab hard-to-get California state park campsites. Users pick campgrounds and date patterns they care about; we scan ReserveCalifornia and email them the moment a matching site opens up.

## 2. Requirements

1. **Catalog.** Sync all parks (~299) and campground facilities (~517) from ReserveCalifornia daily, including lat/long. Facilities that disappear from the API are marked inactive, never deleted — this doubles as our recovery path if IDs change.
2. **Browse.** Users can browse and search the catalog of parks and facilities.
3. **Watches.** A user holds **one active watch** (early-access limit) covering up to **20 facilities** (across any parks) with a shared date pattern: check-in weekdays and nights (1–7). Example: "any Friday, 2 nights — at Moro Campground or San Mateo." **A watch has no date bounds**: it always covers the full booking window and rolls forward as ReserveCalifornia opens new dates. Bounded watches were removed deliberately — they bought nothing (the scanner scans the whole window regardless of what any one watch cares about) and cost an expiry concept, where an expired watch silently kept its campgrounds on the hourly scan tier and blocked the per-user limit forever.
4. **Scanning.** The scanner is the only thing that talks to ReserveCalifornia. It runs continuously, always scanning whichever campground is **most overdue**: watched campgrounds have a one-hour freshness target, everything else twenty-four hours. There are no discrete sweeps and no job queue — see §4.
5. **Availability state.** One row per (facility, unit, date) holding current availability, refreshed each scan. Nights that have already passed are pruned by a daily step in the scanner — `replaceWindow` only rewrites today onward, so past dates would otherwise orphan at ~25k rows/day. Trend data lives in AvailabilityEvent instead.
5b. **Search reads our database only.** Users can check availability for selected campgrounds and a date pattern without creating a watch. Search **never calls ReserveCalifornia** — it is one indexed query, so it answers in ~200ms no matter how many people search at once. It is explicitly a snapshot, not live: every result shows when it was last updated, and a campground never scanned says so rather than reporting "nothing open". Live refresh-on-search was removed deliberately — at 9 requests per campground it made searches compete with the scanner for the one budget that matters, and got unusable at a handful of concurrent users.
6. **Notifications.** Email only, via **Resend** (3,000/month, 100/day free) behind a small sender interface — tests use a logging stub, and swapping to Brevo or SES is one adapter. Sent when a night flips unavailable → available and completes a stay the watch wants. No repeat emails while it stays open. Email links to ReserveCalifornia. Missing `RESEND_API_KEY` degrades to the stub rather than crashing, and says so loudly in the log and the admin panel.
7. **Politeness.** One request every **1 second**, matching camply (`juftin/camply`), which has run against this API for years at that rate. Enforced by a **global rate gate** in `packages/scanner` that every request queues at, so the rate is a property of the process and no amount of concurrency can raise it — only lengthen the queue. Concurrent scans of the same campground are deduplicated rather than run twice. A 429 or 403 trips a circuit breaker that stops all scanning until the block expires; we never retry one, because retrying deepens the penalty — a 15-minute-to-several-hour IP blacklist that takes the whole app down, not just the scan. Caveat: camply spreads its load over thousands of users' IPs in short bursts where we are one Pi running continuously, so 1s is a ceiling, not a target. See `packages/scanner/API.md` §4b.
8. **Monitoring.** Track scanner backlog (campgrounds past their freshness target), worst-case staleness (oldest scan), throughput (campgrounds scanned per hour), emails sent per day, and number of watched campgrounds. A rising backlog or an oldest-scan past its target means we are falling behind and will start missing cancellations.
9. **Admin panel.** Admin-only page: list users, see each user's watches, remove/ban users, run a catalog sync, and read scanner health — status, backlog, worst staleness, throughput. There are no sweep buttons: the scanner picks its own work, so there is nothing to start or stop.
9b. **Endpoints that spend an external budget require an account.** Browsing parks and reading stored availability is public — neither costs us anything outside our own database. `/api/geocode` (OpenStreetMap Nominatim) returns 401 to anonymous callers, because per-request caps bound one request, not how many a stranger opens at once.
10. **RBAC.** Two roles, `admin` and `user`, carried in Auth0 JWT claims and checked in the service layer (same pattern as auth today).
11. **Location search.** "Parks near me" by haversine distance on stored park lat/long. A typed address/city/ZIP is the primary input (geocoded server-side via OpenStreetMap Nominatim — free, throttled to 1 req/sec, cached); browser geolocation is a secondary option because VPNs make it unreliable.
12. **Branding.** CampingMeow favicon (replace the Bookshelf icon). Mascot: a cat in a Super Troopers hat asking if you want to go camping right meow.

## 3. Data model

- **User** — exists today (Auth0 sync). Add role.
- **Park** — RC place id, name, city, lat/long, active flag. Coordinates power distance search.
- **Facility** — RC facility id, name, parent park, active flag, `lastScannedAt` (null = never scanned). No lat/long: RC only has park-level coordinates.
- **Watch** — user, check-in weekdays, nights, active flag. No date bounds, so nothing expires.
- **WatchFacility** — join table: the facilities a watch covers (one pattern, many campgrounds).
- **AvailabilitySlot** — facility, unit id, unit name, date, `isFree`, updated timestamp. Unique per (facility, unit, date). Every night in the scanned window is stored, taken ones included, so a search can tell "booked" from "never scanned".
- **AvailabilityEvent** — facility, unit, night, `opened`/`closed`, `detectedAt`, `notifiedAt`. Append-only log of transitions, written inside the same transaction that overwrites the slots. A night with **no previous row produces no event** — going from "no data" to "40 free nights" is discovery, not 40 openings (first scan of a campground, a new site in the grid, a date rolling into the window). `notifiedAt` makes it a durable outbox: if email is down, events stay unnotified and go out next pass. Also the trend source, which is why pruning past slots is not a loss.
- **EmailLog** — one row per notification batch: `sentAt`, `quantity`, and a JSON `{ userId: [eventId] }` map. The emails-per-day metric.
- *(No job or sweep table.)* Scanner health is derived from `Facility.lastScannedAt`: backlog is the count past its freshness target, throughput is the count scanned in the last hour, and worst-case staleness is the oldest timestamp. A jobs table would be a second, drifting copy of state we already keep.

## 4. Scanner design

One loop, one question — "what is most overdue?" — then scan it and ask again.

```
pickNext():
  watched campground not scanned in the last hour   -> oldest first
  any campground not scanned in the last 24 hours   -> oldest first
  otherwise                                         -> sleep 30s
```

- **No job queue, by design.** Scan work is derivable: it is a pure function of
  `Facility.lastScannedAt`. A queue would be a second copy of state we already
  store, with its own drift, cleanup and locking to get wrong.
- **Crash recovery is free.** Campgrounds already scanned have a fresh
  timestamp and sort to the back, so a restart resumes where it left off.
- **Priority is free.** A newly watched campground has `lastScannedAt = null`,
  which sorts first, so it is picked next without a priority column. Creating a
  watch only nudges the loop awake early.
- **No collisions.** There are no discrete sweeps, so nothing has to be skipped
  or queued behind anything else. Watched work is re-checked every iteration,
  so it always preempts catalog backlog regardless of relative age.
- **Runs in the web app's process, not its own container.** The rate gate that
  keeps us under ReserveCalifornia's limit is per-process state, so a second
  container would get its own gate and silently double our request rate. One
  process, one gate — revisit only with shared (Postgres-backed) state.
- Cost: 9 calls per campground at 1s apart, ~11s each. ~500 campgrounds on a
  24-hour target is roughly a 5% duty cycle, so the loop is idle most of the
  day and watched work never waits.

## 5. Notifications

- On an unavailable → available event, find watches whose pattern matches the slot's facility, weekday, and (with consecutive open nights) night count. No date filtering: a watch covers the whole window.
- The notifier runs on its own **10-minute loop** (there are no sweeps to hang off). It claims `opened` events with `notifiedAt IS NULL`, matches them to watches, groups by user, sends one email each, then stamps `notifiedAt` and writes an EmailLog row.
- An event is one *night*; a watch wants a *stay*. A night opening can complete a multi-night stay whose other nights were already free, so matching checks the candidate check-ins that the opened night could belong to and confirms every night of the stay is free.
- No re-send while it stays open — that falls out of events only firing on transitions, so only within-batch dedup on (watch, unit, check-in) is needed. If it closes and reopens, that's a new event and a new email.
- Email contains facility name, dates, and a link to ReserveCalifornia.

## 6. Out of scope (for now)

- SMS and push notifications.
- More than one watch per user (capped at 1 for early access; raise once the scanner's real duty cycle is measured).
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
- **Expensive external work belongs to the scanner, not the request path.** Read
  paths answer from Postgres and say how old the data is; only the scanner
  calls ReserveCalifornia, behind the global rate gate. We tried the opposite
  (refresh-on-search, streamed over SSE) and removed it: it made every reader
  compete for the one budget that matters and fell over at a handful of
  concurrent users.

## 8. Implementation phases

1. **Catalog** — Park/Facility tables, daily sync job, browse/search UI, favicon.
2. **Watches** — Watch table, CRUD UI on facility pages, date-pattern form.
3. **Scanner** — worker container, AvailabilitySlot/Event/SweepRun, availability shown in UI, on-create scan.
4. **Notifications** — email provider setup, matching logic, dedup, deep links.
5. **Admin + RBAC** — roles in JWT, service-layer checks, admin panel with users/watches/metrics, ban.
6. **Location search** — geolocation, distance sort/filter.
7. **Polish** — mascot UX, empty states, trends if we feel like it.

Each phase ships behind the existing CI/CD pipeline with e2e coverage before moving on.
