# CampingMeow — Project Spec

## 1. Purpose

CampingMeow helps people grab hard-to-get California state park campsites. The
good sites are booked out months ahead, but people cancel constantly and those
sites go back on ReserveCalifornia with nobody watching. Users pick campgrounds
and a date pattern; we watch, and email them when a match opens.

## 2. Requirements

1. **Catalog.** Sync all parks (~299) and campground facilities (~517) from
   ReserveCalifornia daily, including lat/long. Facilities that vanish from the
   API are marked inactive, never deleted — that doubles as the recovery path if
   ids change.
2. **Browse.** Users can browse and search the catalog.
3. **Location search.** "Parks near me" by haversine distance on stored park
   lat/long. A typed address/city/ZIP is the primary input, geocoded server-side
   via OpenStreetMap Nominatim (free, 1 req/sec, cached); browser geolocation is
   secondary, because VPNs make it unreliable.
4. **Watches.** Up to **10 active watches** per user, each covering up to **20
   facilities** across any parks, with one shared date pattern: check-in
   weekdays and nights (1–7). *"Any Friday, 2 nights, at Moro or San Mateo."*
   A watch has **no date bounds** — it covers the scanner's rolling window and
   moves with it, so nothing expires. Bounded watches were removed: the scanner
   scans the same window regardless of what any watch asks for, so they bought
   nothing and cost an expiry concept.
5. **Scanning.** The scanner is the only thing that talks to ReserveCalifornia.
   It sweeps **every bookable campground across a 63-day window**, continuously.
   Cost depends on the catalog, never on how many users or watches exist. See §4.
6. **Search reads our database only.** Users can check availability without
   creating a watch. Search **never calls ReserveCalifornia** — one indexed
   query, ~200ms regardless of load. It is explicitly a snapshot: every result
   says when it was last updated, a campground never scanned says so rather than
   reporting "nothing open", and dates past the window are refused rather than
   answered from data we do not have.
7. **Available nearby.** The product's first question — *"I want to go camping,
   where can I go?"* — answered as a grid: campgrounds down the side, the next
   63 nights across the top, shaded by how many sites are free. Location plus a
   radius, filterable by type of camping, and rows can be selected straight
   into a watch. Deliberately **no date filter and no weekend default**: we do
   not know when someone wants to go, so the grid shows every night and tints
   weekends rather than choosing for them. A cell means *one site free that
   night* and says so — two green cells side by side may be different sites, so
   a run does not promise a multi-night stay. Fully booked campgrounds are
   hidden, with a count, so the page is openings rather than a wall of grey.
8. **Notifications.** Email only, via **Resend**, behind a small sender
   interface — tests use a logging stub, and swapping to Brevo or SES is one
   adapter. Sent when a night flips unavailable → available and completes a stay
   a watch wants. See §5.
9. **Politeness.** One request per **second**, matching camply
   (`juftin/camply`), which has run against this API for years at that rate.
   Enforced by a **global rate gate** in `packages/scanner` that every request
   queues at, so the rate is a property of the process: no amount of concurrency
   can raise it, only lengthen the queue. Concurrent scans of one campground are
   deduplicated rather than run twice. A 429 or 403 trips a circuit breaker that
   stops all scanning; we never retry one, because retrying deepens the penalty
   — a 15-minute-to-several-hour IP blacklist takes the whole app down, not just
   the scan. Caveat: camply spreads its load over thousands of users' IPs in
   short bursts, where we are one Pi running continuously, so 1s is a ceiling,
   not a target. See `packages/scanner/API.md` §4b.
10. **Monitoring.** Scanner **cycle time** is the number that says whether we are
   keeping up, alongside campgrounds scanned and failed per pass, and emails
   sent. A 429 from ReserveCalifornia is an incident, not a metric: it stops
   scanning and mail together, and the admin panel raises it as one.
11. **Admin panel.** Admin-only: list users with what they watch and how much
    email they have had, ban and unban accounts, run a catalog sync, re-check
    non-bookable campgrounds, pause or resume the sweep, and read scanner and
    notifier health. A ban signs an account out everywhere and stops its email;
    nothing is deleted, so watches and settings survive an unban. An admin
    cannot ban themselves.
12. **RBAC.** Two roles, `admin` and `user`, carried in Auth0 JWT claims and
    checked in the service layer. No role column: Auth0 is the source of truth.
13. **Reading is public; changing things is not.** Browsing parks, searching
    availability, and the nearby grid all answer from our own database and are
    open to everyone — finding somewhere to camp is the product's main question
    and gating it would gate the product. Geocoding is public too: what keeps
    us inside OpenStreetMap's policy is the one-request-per-second throttle in
    `lib/nominatim.server.ts`, which is process-wide, not an auth check.
    Watches, preferences and every admin action require an account.
14. **We say what we do not do.** Past the 63-day window we link to
    ReserveCalifornia (`reservecalifornia.com/park/{rcPlaceId}/{rcFacilityId}` —
    both ids are stored), which browses the full six months better than we
    would. For anyone wanting faster or broader scanning than one shared IP can
    give, we link to camply, which runs on their machine with their own budget.
    Both are honest answers rather than limits dressed up as features.
15. **Branding.** CampingMeow favicon. Mascot: a cat in a Super Troopers hat
    asking if you want to go camping right meow.

## 3. Data model

- **User** — Auth0 sync (email, name), plus `bannedAt`. A timestamp rather
  than a flag so we know when, and null rather than a deleted row so an unban
  restores the account intact. A banned account reads as signed out everywhere
  and the notifier skips it. Roles come from the JWT, not a column.
- **Park** — RC place id, name, city, lat/long, active flag.
- **Facility** — RC facility id, name, parent park, active flag,
  `lastScannedAt`, `bookableSites`, `status`, `siteCategories` and
  `maxVehicleLength`. No lat/long: RC only has park-level coordinates.

  | `status` | Meaning | Measured |
  |---|---|---|
  | `bookable` | has web-bookable sites | 335 |
  | `no_inventory` | RC returns no units at all | 139 |
  | `first_come_first_served` | units exist, none web-bookable | 38 |

  Only `bookable` campgrounds are scanned. The other two are **disabled in the
  picker**, with the reason shown — a watch on them could never fire, because
  nothing is reservable, so there is no cancellation to catch. Hiding them
  outright would leave someone wondering where a campground went.

  `siteCategories` is the set of RC `UnitCategoryId`s the last scan saw, and
  drives the type icons shown next to a campground everywhere it appears.
  Measured across 60 campgrounds: seven ids, and 83% of campgrounds use exactly
  one — but mixed ones are real ("Paso Picacho Campground & Cabins" reports both
  `1` and `1008`), so it is a set, not a single value.

  | Id | Type | Id | Type |
  |---|---|---|---|
  | `1` | campsite | `1014` | hike-in / boat-in |
  | `2` | group camp | `1015` | RV hookup |
  | `7` | day use | `1016` | horse camp |
  | `1008` | cabin | | |

  Raw RC ids are stored and mapped to labels in `app/lib/site-types.ts`, so a
  category RC invents later shows up as an unknown id and is dropped from
  display rather than mislabelled. `maxVehicleLength` is stored alongside but is
  **not** a site type — a plain tent-image campsite routinely reports 35ft,
  because most drive-in sites fit an RV. It answers "will my trailer fit",
  which is a future filter, not an icon.
- **Watch** — user, check-in weekdays, nights, active flag.
- **WatchFacility** — join table: the campgrounds one watch covers.
- **AvailabilitySlot** — facility, unit id, unit name, date, `isFree`, updated
  timestamp; unique per (facility, unit, date). Every night in the window is
  stored, taken ones included, so search can tell "booked" from "never scanned".
- **AvailabilityEvent** — facility, unit, night, `opened`/`closed`,
  `detectedAt`, `notifiedAt`. Append-only transitions, written in the same
  transaction that overwrites the slots. A night with **no previous row produces
  no event** — "no data" to "40 free nights" is discovery, not 40 openings
  (first scan, a new site in the grid, a date rolling into the window).
  `notifiedAt` makes it a durable outbox. Also the trend source, which is why
  pruning past slots is not a loss.
- **UserPreference** — `emailNotifications` and an `unsubscribeToken`. The token
  is a stored random value rather than a signature on purpose: an unsubscribe
  link must never expire (a dead one gets reported as spam), must be revocable
  by regenerating it, and must survive a `SESSION_SECRET` rotation.
- **EmailLog** — one row per notification batch: `sentAt`, `quantity`, and a
  JSON `{ userId: [eventId] }` map. Powers the sent metric and the quota check.
- *(No job or sweep table.)* The scanner sweeps everything every pass, so there
  is no work to schedule and nothing to record. Health is the duration of the
  last pass, held in memory.

## 4. Scanner design

```
forever:
  prune nights outside the 63-day window
  scan every bookable campground   (writes slots and transition events)
  run the notifier                 (emails whatever those scans opened up)
```

No tiers, no priorities, no watched/unwatched distinction, no queue. Because
everything is scanned every pass, "most overdue" has no meaning and there is no
freshness target to miss — cycle duration is the only health metric that counts.

It runs in the web app's process on purpose: the rate gate is per-process state,
so a second container would get its own gate and silently double our request
rate. That makes single-instance an assumption rather than a coincidence — two
processes would also double-send email, since claiming events and stamping them
is a read-then-write with the whole send loop in between.

### A cycle survives being interrupted

A pass keeps its start time until it finishes, and the work remaining is
derived: any campground whose `lastScannedAt` predates that start still needs
doing. So a pause, or a crash, costs nothing but the campground in flight — the
next pass picks up where the last one stopped instead of restarting at zero.
That mattered: the process died thirteen times in a day before the leak below
was found, and each restart used to throw away up to an hour of sweeping.

An admin can pause the sweep from the panel. It is checked between campgrounds
rather than between cycles, because a pause that waits half an hour is not a
pause.

### Writing only what changed

A scan produces the campground's whole window, but between two passes 25
minutes apart almost none of it has moved. Rewriting all of it — ~3,200 rows for
a mid-size campground — was both wasteful and, as it turned out, fatal: Prisma
retained its serialised query for a write that large, about 19MB per scan,
until the process ran out of heap and was killed.

So the write is now a delta. `diffSlots` compares the new window to the stored
one and writes only nights that changed, plus any the grid has stopped
reporting. Measured against a stand-in API: a first scan writes 3,200 rows in
600ms, and every scan after writes **nothing** in 35ms, or ~58 rows when 1% of
nights flip. Memory is flat across hundreds of scans.

The first scan of a campground still writes the whole window, so that insert is
chunked — one statement with 22,400 bind parameters is within Postgres's 65,535
limit but not comfortably, and it is what the leak fed on.

### Why one flat loop

The scanner used to tier by who was watching, which made cost a function of
**user count** — worse as the product succeeds. Scanning everything makes it a
function of the **catalog**, which is fixed and never grows. Break-even is ~170
watched campgrounds; past that, watched-only scanning costs *more* than sweeping
the whole state. That is roughly 10–20 users, so the flat loop is cheaper almost
immediately and never degrades. Everything downstream got simpler: no demand
classes, no horizon tiers, no `watchedOnly` query.

### The budget

21 days per API call, so a 63-day window is **3 calls per campground**, and only
the 335 bookable ones are scanned. Measured **4.07s per campground** — three
gated calls plus network and the slot write — so a full cycle is **~23 minutes**.
The naive `3 × 1s = 3s` figure is optimistic; latency does not overlap the gate.

### Why 63 days and not 180

Two thirds of every scan used to go to days 63–180, the part of the window
people care about least. Measured weekend availability:

| Horizon | Weekend nights free |
|---|---|
| 0–21 days | 12.8% |
| 21–63 days | 15.6% |
| 63–180 days | 27.1% |

Far dates are about twice as easy to book, and they are where the money went. 63
days matches what the product is for — "I want to go camping soon" — and is what
makes sweeping the whole catalog affordable.

### Pruning both ends

`replaceWindow` only deletes the range it replaces, so anything outside the
window is never updated *and* never removed. That stranded **984,555 rows**, a
third of them marked free — six-month-old data that search and the calendar
would have shown as current. The prune therefore runs every pass and deletes on
**both** sides: nights before today, and nights beyond `today + 63`. Not a
one-off cleanup — every pass strands another day at the far edge.

### Status classification

Every scan records what the grid returned, so `status` is a by-product of work
we already do. A campground is demoted the first time it reports nothing
bookable.

**Self-healing is deliberately not built.** A seasonal campground demoted in
winter stays demoted until an admin re-checks it, and one bad response can
demote a healthy campground. Both are accepted for now: the fix (require
consecutive observations, and re-probe the far end of the booking window rather
than today) is understood and written down, and an admin action re-checks all
non-bookable campgrounds on demand.

## 5. Notifications

The notifier runs **once at the end of each scan pass**, never on a loop of its
own: a pass is exactly the unit of work that produces events, so there is
nothing to poll for, and one run per pass batches a user's openings into a
single email instead of one per campground. If ReserveCalifornia blocks us, the
sweep stops and mail stops with it — deliberately.

It claims `opened` events with `notifiedAt IS NULL`, matches them to watches,
groups by user, sends one email each, then stamps the events and writes an
EmailLog row.

- **An event is one night; a watch wants a stay.** A night opening can complete
  a multi-night stay whose other nights were already free, so matching walks the
  candidate check-ins that the opened night could belong to and confirms every
  night of the stay is free on that one site.
- **No re-send while it stays open** — that falls out of events firing only on
  transitions, so only within-batch dedup on (watch, unit, check-in) is needed.
  Close and reopen is a new event and a new email.
- **Only events whose mail went out are stamped.** A failed send, or one held by
  the daily cap, stays unnotified for the next pass. An event matched by two
  users, one unreachable, is held for both — so that user may get a second copy
  later. A duplicate is a far smaller failure than never being told a site
  opened, which is the one thing the product promises.
- **Email is a channel, not the subscription.** Turning it off leaves the watch
  running and the openings visible in-app; the notifier just skips that user.
  Deactivating a watch is a separate action on `/watches`.

### Unsubscribe

`/preferences` works signed in **or** with the token from an email. Loading it
never changes anything — mail scanners follow every link in an email, so a link
that acted on GET would unsubscribe people who never clicked. The toggle is a
POST, and `List-Unsubscribe` + `List-Unsubscribe-Post` (RFC 8058) give Gmail its
native button, which also POSTs. The token grants exactly one power: toggling
that user's email. It is never a login, and reveals nothing beyond the address
the mail already reached.

### The daily cap

Resend's free tier is 100 emails a day, and per their docs the quota **resets 24
hours after each send** rather than at midnight. So we count over a *trailing
24-hour window*: counting to midnight would let us send 100 at 11pm and 100 more
an hour later, and the second hundred would be refused.

We stop at **95**. Hitting our own cap pauses sending cleanly; hitting theirs is
a 429 mid-batch. If Resend returns `daily_quota_exceeded` anyway — it can see
mail we did not send, from the dashboard or another app on the key — that answer
outranks our tally and stops the pass.

Openings found while paused are still recorded and visible in the app, but they
are not queued for mail. Budget returns on its own as the oldest batch ages out
of the window, and the sweep running at that point finds whatever is open then.
The home page says alerts are paused and roughly when they resume, because
otherwise silence looks exactly like "nothing has opened" — and the whole
promise of the product is that silence means nothing has opened.

## 6. Out of scope (for now)

- SMS and push notifications.
- Non-California sources.
- Trend charts — we keep the data, we do not build the UI.
- Multi-instance deployment (see §4: the rate gate and the outbox both assume
  one process).

## 7. Architecture conventions

Each layer only talks to the one below it.

1. **Routes** (`app/routes/`) — thin. Parse the request, call one service,
   return its result. No business logic, no Prisma.
2. **Services** (`app/services/`) — all business logic, exported as named
   objects, one domain per file. A service that coordinates other services
   rather than repositories is named `<thing>OrchestratorService`; none exist
   today. Services return data already shaped for the UI.
3. **Repositories** (`app/repositories/`) — Prisma queries only, one per entity,
   no business logic.
4. **UI components** — display only. Rendering logic is fine; business logic is
   not.

Supporting rules:

- Files are `<thing>.service.server.ts` / `<thing>.repository.server.ts`. The
  `.server` suffix is load-bearing — it keeps the file out of the client bundle.
- `packages/scanner` is the data-access layer for ReserveCalifornia: a thin
  typed client, no business logic. It is to RC what repositories are to Postgres.
- **Expensive external work belongs to the scanner, not the request path.** Read
  paths answer from Postgres and say how old the data is. We tried the opposite
  (refresh-on-search, streamed over SSE) and removed it: it made every reader
  compete for the one budget that matters, and fell over at a handful of
  concurrent users.
- **Pages never crash.** Every page route exports `ErrorBoundary` (re-export
  `PageErrorBoundary`), so a failure keeps the app shell and surfaces as a toast
  plus a recoverable inline message. Expected failures (validation) come back as
  data the form renders inline; unexpected ones become the toast. Services throw
  typed errors (`ValidationError`, `ForbiddenError`); routes translate them.
- UI is built from shadcn-style components in `packages/ui` wrapping Radix
  primitives. Never hand-roll a widget Radix provides — hand-rolled interactive
  markup loses keyboard support, ARIA state, and focus management.
- Authorization checks live in the service layer, never in routes or
  repositories.

## 8. Status

Built and deployed: catalog sync, browse, location search, watches, the scanner
sweep, availability events, search, the nearby availability grid, site-type
icons, notification email with one-click unsubscribe, the daily email cap,
preferences, admin panel with user bans and sweep pause, RBAC.

Not built:

- **Self-healing `no_inventory`** (§4), and consecutive-scan confirmation before
  demoting a campground.
- **A per-user campground cap.** Watches are capped by count (10) and width
  (20); capping distinct campgrounds instead would track email volume more
  closely.
- **Pruning `AvailabilityEvent`.** Nothing deletes from it and nothing reads old
  rows yet. Kept deliberately as the trend source, but it grows by tens of
  thousands of rows a day and will need a retention window before it is used.
