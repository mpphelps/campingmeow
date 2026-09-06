# CampingMeow — Project Spec

## 1. Purpose

CampingMeow helps people grab hard-to-get California state park campsites. Users pick campgrounds and date patterns they care about; we scan ReserveCalifornia and email them the moment a matching site opens up.

## 2. Requirements

1. **Catalog.** Sync all parks (~299) and campground facilities (~517) from ReserveCalifornia daily, including lat/long. Facilities that disappear from the API are marked inactive, never deleted — this doubles as our recovery path if IDs change.
2. **Browse.** Users can browse and search the catalog of parks and facilities.
3. **Watches.** A user may hold up to **10 active watches**, each covering up to **20 facilities** (across any parks) with a shared date pattern: check-in weekdays and nights (1–7). Example: "any Friday, 2 nights — at Moro Campground or San Mateo." **A watch has no date bounds**: it covers the scanner's rolling 63-day window and moves forward with it, so nothing ever expires. Bounded watches were removed deliberately — the scanner scans the same window regardless of what any one watch asks for, so they bought nothing and cost an expiry concept.
4. **Scanning.** The scanner is the only thing that talks to ReserveCalifornia. It runs continuously over **every bookable campground across a 63-day window**, cycling roughly every 22 minutes. There are no tiers, no watched/unwatched distinction, and no job queue — see §4. Scan cost depends on the catalog, never on how many users or watches exist.
5. **Availability state.** One row per (facility, unit, date) holding current availability, refreshed each scan. Nights that have already passed are pruned by a daily step in the scanner — `replaceWindow` only rewrites today onward, so past dates would otherwise orphan at ~25k rows/day. Trend data lives in AvailabilityEvent instead.
5b. **Search reads our database only.** Users can check availability for selected campgrounds and a date pattern without creating a watch. Search **never calls ReserveCalifornia** — it is one indexed query, so it answers in ~200ms no matter how many people search at once. It is explicitly a snapshot, not live: every result shows when it was last updated, and a campground never scanned says so rather than reporting "nothing open". Live refresh-on-search was removed deliberately — at 9 requests per campground it made searches compete with the scanner for the one budget that matters, and got unusable at a handful of concurrent users.
6. **Notifications.** Email only, via **Resend** (3,000/month, 100/day free) behind a small sender interface — tests use a logging stub, and swapping to Brevo or SES is one adapter. Sent when a night flips unavailable → available and completes a stay the watch wants. No repeat emails while it stays open. Email links to ReserveCalifornia. Missing `RESEND_API_KEY` degrades to the stub rather than crashing, and says so loudly in the log and the admin panel.
7. **Politeness.** One request every **1 second**, matching camply (`juftin/camply`), which has run against this API for years at that rate. Enforced by a **global rate gate** in `packages/scanner` that every request queues at, so the rate is a property of the process and no amount of concurrency can raise it — only lengthen the queue. Concurrent scans of the same campground are deduplicated rather than run twice. A 429 or 403 trips a circuit breaker that stops all scanning until the block expires; we never retry one, because retrying deepens the penalty — a 15-minute-to-several-hour IP blacklist that takes the whole app down, not just the scan. Caveat: camply spreads its load over thousands of users' IPs in short bursts where we are one Pi running continuously, so 1s is a ceiling, not a target. See `packages/scanner/API.md` §4b.
8. **Monitoring.** Track scanner **cycle time** (how long a full pass takes — the number that says whether we are keeping up), worst-case staleness (oldest scan), throughput (campgrounds scanned per hour), and emails sent per day. A rising backlog or an oldest-scan past its target means we are falling behind and will start missing cancellations.
9. **Admin panel.** Admin-only page: list users, see each user's watches, remove/ban users, run a catalog sync, and read scanner health — status, backlog, worst staleness, throughput. There are no sweep buttons: the scanner picks its own work, so there is nothing to start or stop.
9b. **Endpoints that spend an external budget require an account.** Browsing parks and reading stored availability is public — neither costs us anything outside our own database. `/api/geocode` (OpenStreetMap Nominatim) returns 401 to anonymous callers, because per-request caps bound one request, not how many a stranger opens at once.
10. **RBAC.** Two roles, `admin` and `user`, carried in Auth0 JWT claims and checked in the service layer (same pattern as auth today).
11. **Location search.** "Parks near me" by haversine distance on stored park lat/long. A typed address/city/ZIP is the primary input (geocoded server-side via OpenStreetMap Nominatim — free, throttled to 1 req/sec, cached); browser geolocation is a secondary option because VPNs make it unreliable.
11b. **We say what we do not do.** Past the 63-day window we link to ReserveCalifornia (`reservecalifornia.com/park/{rcPlaceId}/{rcFacilityId}` — both ids are stored), which browses the full six months better than we would. For anyone wanting faster or broader scanning than one shared IP can give, we link to camply (`juftin/camply`), which runs on their machine with their own budget. Both are honest answers rather than limits dressed up as features.
12. **Branding.** CampingMeow favicon (replace the Bookshelf icon). Mascot: a cat in a Super Troopers hat asking if you want to go camping right meow.

## 3. Data model

- **User** — exists today (Auth0 sync). Add role.
- **Park** — RC place id, name, city, lat/long, active flag. Coordinates power distance search.
- **Facility** — RC facility id, name, parent park, active flag, `lastScannedAt` (null = never scanned), `bookableSites` (web-bookable units seen on the last scan), and `status`. No lat/long: RC only has park-level coordinates.

  `status` is one of:

  | Status | Meaning | Measured |
  |---|---|---|
  | `bookable` | has web-bookable sites | 335 |
  | `no_inventory` | RC returns no units at all | 139 |
  | `first_come_first_served` | units exist, none web-bookable | 38 |

  Only `bookable` campgrounds are scanned. The other two are **excluded from the picker** — a watch on them could never fire, because nothing is reservable, so there is no cancellation to catch. FCFS is a permanent property; `no_inventory` may be seasonal, but self-healing is deliberately **not** built yet (see §4).
- **Watch** — user, check-in weekdays, nights, active flag. No date bounds, so nothing expires.
- **WatchFacility** — join table: the facilities a watch covers (one pattern, many campgrounds).
- **AvailabilitySlot** — facility, unit id, unit name, date, `isFree`, updated timestamp. Unique per (facility, unit, date). Every night in the scanned window is stored, taken ones included, so a search can tell "booked" from "never scanned".
- **AvailabilityEvent** — facility, unit, night, `opened`/`closed`, `detectedAt`, `notifiedAt`. Append-only log of transitions, written inside the same transaction that overwrites the slots. A night with **no previous row produces no event** — going from "no data" to "40 free nights" is discovery, not 40 openings (first scan of a campground, a new site in the grid, a date rolling into the window). `notifiedAt` makes it a durable outbox: if email is down, events stay unnotified and go out next pass. Also the trend source, which is why pruning past slots is not a loss.
- **UserPreference** — per user: `emailNotifications`, plus an `unsubscribeToken`. The token is a stored random value rather than a signature on purpose: an unsubscribe link must never expire (a dead one gets reported as spam instead), must be revocable by regenerating it, and must survive a `SESSION_SECRET` rotation.
- **EmailLog** — one row per notification batch: `sentAt`, `quantity`, and a JSON `{ userId: [eventId] }` map. The emails-per-day metric.
- *(No job or sweep table.)* Scanner health is derived from `Facility.lastScannedAt`: backlog is the count past its freshness target, throughput is the count scanned in the last hour, and worst-case staleness is the oldest timestamp. A jobs table would be a second, drifting copy of state we already keep.

## 4. Scanner design

**Every bookable campground, a 63-day window, on repeat.** No tiers, no
priorities, no watched/unwatched distinction.

```
pickNext():
  the campground whose window is most overdue -> oldest first
  nothing overdue -> sleep
```

### Why one flat loop

The scanner used to tier by who was watching. That made scan cost a function of
**user count**, which gets worse as the product succeeds — the opposite of what
you want. Scanning everything makes cost a function of the **catalog**, which is
fixed at ~500 and never grows.

The break-even is ~170 watched campgrounds: past that, watched-only scanning
costs *more* than scanning the entire state to 63 days. With watch limits gone
that is roughly 10-20 users, so the flat loop is cheaper almost immediately and
never degrades.

Everything downstream gets simpler: no demand classes, no horizon tiers, no
`MAX_WATCHES_PER_USER`, no `watchedOnly` query.

### The budget

- 21 days per API call, so a 63-day window is **3 calls per campground**.
- Only `bookable` campgrounds are scanned. 177 of ~512 are not (see §3).
- Measured **4.07s per campground** (3 gated calls plus network and the slot write), so 335 x 4.07s = **~23 minutes** per cycle. The naive `3 calls x 1s = 3s` figure is optimistic; latency does not overlap the gate wait.

Freshness target is **25 minutes**, a little above the measured cycle so a newly
created watch can be scanned without pushing the cycle over.

### Status classification

Every scan records what the grid returned, so `status` is a by-product of work
we already do rather than a separate pass. A campground is demoted the first
time it reports nothing bookable.

**Self-healing is deliberately not built.** A seasonal campground demoted in
winter stays demoted until an admin re-checks it, and a single bad response can
demote a healthy campground. Both are accepted for now: production has no users,
and the fix (require consecutive observations, and re-probe the far end of the
booking window rather than today) is understood and written down. An admin
action re-checks all non-bookable campgrounds on demand.

### Pruning both ends of the window

`replaceWindow` only deletes the range it replaces, so anything outside the
window is never updated *and* never removed. With a 63-day window that stranded
**984,555 rows**, a third of them marked free — six-month-old data that search
and the calendar would have shown as current.

The daily prune therefore deletes on **both sides**: nights before today, and
nights beyond `today + 63`. This is not a one-off cleanup; every scan strands
another day at the far edge.

### Why 63 days and not 180

Two thirds of every scan used to go to days 63-180, the part of the window
people care about least. Measured weekend availability:

| Horizon | Weekend nights free |
|---|---|
| 0-21 days | 12.8% |
| 21-63 days | 15.6% |
| 63-180 days | 27.1% |

Far dates are about twice as easy to book, and they are where the money went.
63 days matches what the product is for — "I want to go camping soon" — and is
an honest boundary rather than a limitation we hide.

For anything further out we link to ReserveCalifornia, which already browses the
full window well. For anyone who wants faster or broader scanning than one
shared IP can offer, we link to camply (`juftin/camply`), which runs on their
machine with their own budget. Both are truthful answers, not apologies.

### Properties that come for free

- **No job queue.** Scan work is derivable from `Facility.lastScannedAt`, so a
  queue would be a second copy of state we already store.
- **Crash recovery.** Scanned campgrounds have a fresh timestamp and sort to the
  back, so a restart resumes where it left off.
- **Priority.** A newly watched campground has `lastScannedAt = null`, which
  sorts first. Creating a watch only nudges the loop awake early.
- **Runs in the web app's process, not its own container.** The rate gate that
  keeps us under ReserveCalifornia's limit is per-process state, so a second
  container would get its own gate and silently double our request rate.

## 5. Notifications

- On an unavailable → available event, find watches whose pattern matches the slot's facility, weekday, and (with consecutive open nights) night count. No date filtering: a watch covers the whole window.
- The notifier runs on its own **10-minute loop** (there are no sweeps to hang off). It claims `opened` events with `notifiedAt IS NULL`, matches them to watches, groups by user, sends one email each, then stamps `notifiedAt` and writes an EmailLog row.
- An event is one *night*; a watch wants a *stay*. A night opening can complete a multi-night stay whose other nights were already free, so matching checks the candidate check-ins that the opened night could belong to and confirms every night of the stay is free.
- No re-send while it stays open — that falls out of events only firing on transitions, so only within-batch dedup on (watch, unit, check-in) is needed. If it closes and reopens, that's a new event and a new email.
- Email contains facility name, dates, a link to ReserveCalifornia, and an unsubscribe link.
- **Email is a delivery channel, not the subscription.** Turning it off leaves the watch running, so the openings are still there to see in-app; the notifier simply skips that user. Deactivating the watch is a separate action on `/watches`.
- `/preferences` works signed in **or** with the token from an email. Loading it never changes anything — mail scanners follow every link in an email, so a link that acted on GET would unsubscribe people who never clicked. The toggle is a POST, and `List-Unsubscribe` + `List-Unsubscribe-Post` (RFC 8058) give Gmail its native button, which POSTs.
- The token grants exactly one power: toggling that user's email. It is never a login, and shows nothing beyond the address the mail already went to.

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
