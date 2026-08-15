# CampingMeow — Project Spec

## 1. Purpose

CampingMeow helps people grab hard-to-get California state park campsites. Users pick campgrounds and date patterns they care about; we scan ReserveCalifornia and email them the moment a matching site opens up.

## 2. Requirements

1. **Catalog.** Sync all parks (~299) and campground facilities (~517) from ReserveCalifornia daily, including lat/long. Facilities that disappear from the API are marked inactive, never deleted — this doubles as our recovery path if IDs change.
2. **Browse.** Users can browse and search the catalog of parks and facilities.
3. **Watches.** A user creates a watch on a facility with a date pattern: a set of check-in weekdays, a number of nights (1–7), and optional start/end date bounds. Example: "any Friday, 2 nights, June–August."
4. **Scanning.** A background worker scans only watched facilities, on repeat, across the full 6-month booking window. When a watch is created for a facility not yet in rotation, that facility is scanned immediately so the user sees data right away.
5. **Availability state.** One row per (facility, unit, date) holding current availability, upserted each scan. Rows for past dates are kept for future trending features.
6. **Notifications.** Email only (free-tier provider such as Resend). Sent when a slot flips unavailable → available and matches a watch. No repeat emails while the slot stays open. Email links to the facility's page on ReserveCalifornia.
7. **Politeness.** Delay between API calls (500ms baseline), back off on errors. We are a guest on an undocumented API.
8. **Monitoring.** Track sweep duration, emails sent per day, and number of watched facilities. If sweeps get slow we miss cancellations; if emails spike we hit provider limits. These metrics must be visible (admin panel) before we need them.
9. **Admin panel.** Admin-only page: list users, see each user's watches, remove/ban users, and view the health metrics above.
10. **RBAC.** Two roles, `admin` and `user`, carried in Auth0 JWT claims and checked in the service layer (same pattern as auth today).
11. **Location search.** "Facilities near me" using browser geolocation and haversine distance on stored lat/long. Geocoding only if the user types an address.
12. **Branding.** CampingMeow favicon (replace the Bookshelf icon). Mascot: a cat in a Super Troopers hat asking if you want to go camping right meow.

## 3. Data model

- **User** — exists today (Auth0 sync). Add role.
- **Park** — RC place id, name, lat/long, active flag.
- **Facility** — RC facility id, name, parent park, lat/long, active flag.
- **Watch** — user, facility, check-in weekdays, nights, optional date bounds, active flag.
- **AvailabilitySlot** — facility, unit id, date, available flag, last-seen timestamp. Current state; past dates retained.
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

## 7. Implementation phases

1. **Catalog** — Park/Facility tables, daily sync job, browse/search UI, favicon.
2. **Watches** — Watch table, CRUD UI on facility pages, date-pattern form.
3. **Scanner** — worker container, AvailabilitySlot/Event/SweepRun, availability shown in UI, on-create scan.
4. **Notifications** — email provider setup, matching logic, dedup, deep links.
5. **Admin + RBAC** — roles in JWT, service-layer checks, admin panel with users/watches/metrics, ban.
6. **Location search** — geolocation, distance sort/filter.
7. **Polish** — mascot UX, empty states, trends if we feel like it.

Each phase ships behind the existing CI/CD pipeline with e2e coverage before moving on.
