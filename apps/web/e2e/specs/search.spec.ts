import { test, expect } from "../test-fixtures";
import { createPark, createFacility, createSlots, nextWeekday, isoDate } from "../utilities/utilities";

// /search answers from our database (AvailabilitySlot rows) but refreshes anything scanned
// more than five minutes ago first, so seeding `lastScannedAt: new Date()` keeps a test on
// the stored-data path. The suite also runs with RC_API_OFFLINE=1 (playwright.config.ts),
// which makes every ReserveCalifornia call throw before it leaves the process — a belt-and-
// braces guard so no test, and no background scan a test kicks off, can hit the live API.
test.describe("search page — form only (no live data)", () => {
  test("renders the form for valid facilities without requesting results", async ({ page }) => {
    const park = await createPark({ name: "Sequoia" });
    const facility = await createFacility({ name: "Lodgepole", parkId: park.id });

    await page.goto(`/search?facilities=${facility.id}`);

    await expect(page.getByRole("heading", { name: "Check availability" })).toBeVisible();

    // Fri + Sat are the default check-in days.
    await expect(page.getByLabel("Fri")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByLabel("Sat")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByLabel("Sun")).toHaveAttribute("aria-checked", "false");

    await expect(page.getByLabel("Nights")).toHaveValue("1");
    await expect(page.getByRole("button", { name: "Check availability" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Watch these instead" })).toHaveAttribute(
      "href",
      `/watches/new?facilities=${facility.id}`,
    );

    // No `days` param at all in the URL, so the loader must not have queried results.
    await expect(page.getByText("matching check-in date", { exact: false })).toHaveCount(0);
  });

  test("returns 404 when the facilities param is missing", async ({ page }) => {
    const response = await page.goto("/search");
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
  });

  test("returns 404 when the facilities param resolves to nothing", async ({ page }) => {
    const response = await page.goto("/search?facilities=does-not-exist");
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
  });

  test("only reveals date inputs when a specific date range is chosen", async ({ page }) => {
    const park = await createPark({ name: "Death Valley" });
    const facility = await createFacility({ name: "Furnace Creek", parkId: park.id });

    await page.goto(`/search?facilities=${facility.id}`);

    await expect(page.locator("#from")).toHaveCount(0);
    await expect(page.locator("#to")).toHaveCount(0);

    await page.getByLabel("Only between specific dates").click();
    await expect(page.locator("#from")).toBeVisible();
    await expect(page.locator("#to")).toBeVisible();

    await page.getByLabel("Anytime in the booking window").click();
    await expect(page.locator("#from")).toHaveCount(0);
  });

  test("shows a validation error when nights is out of range", async ({ page }) => {
    const park = await createPark({ name: "Anza-Borrego" });
    const facility = await createFacility({ name: "Borrego Palm Canyon", parkId: park.id, lastScannedAt: new Date() });

    // The Nights input has HTML5 min={1}/max={7}, so typing "9" and clicking submit never
    // reaches the server — the browser's own constraint validation blocks it first. The
    // server-side "Nights must be between 1 and 7." message is only reachable by a URL a
    // user could still hand-edit or bookmark, so we go there directly.
    await page.goto(`/search?facilities=${facility.id}&days=5&days=6&nights=9&bounds=anytime`);

    await expect(page.getByText("Nights must be between 1 and 7.")).toBeVisible();
  });
});

test.describe("search page — results from stored availability", () => {
  test("shows openings that match seeded free nights", async ({ page }) => {
    const park = await createPark({ name: "Yosemite" });
    const facility = await createFacility({ name: "Upper Pines", parkId: park.id, lastScannedAt: new Date() });

    const fri = nextWeekday(5);
    const sat = nextWeekday(6);
    await createSlots({ facilityId: facility.id, unitName: "Site 12", dates: [fri, sat] });

    // Explicit days=5&days=6 (Fri, Sat) with the default 1 night — matches the seeded slots.
    await page.goto(`/search?facilities=${facility.id}&days=5&days=6`);

    await expect(page.getByText(/matching check-in dates? between \d{4}-\d{2}-\d{2} and \d{4}-\d{2}-\d{2}\./)).toBeVisible();
    await expect(page.getByText(`Fri ${isoDate(fri)}`)).toBeVisible();
    await expect(page.getByText(`Sat ${isoDate(sat)}`)).toBeVisible();
    await expect(page.getByText("1 site: Site 12")).toHaveCount(2);

    // Scanned, so no "unscanned" callout.
    await expect(page.getByText("so there's nothing to search", { exact: false })).toHaveCount(0);
  });

  test("shows a scanned-but-nothing-open message when there are no free nights", async ({ page }) => {
    const park = await createPark({ name: "Big Sur" });
    const facility = await createFacility({ name: "Pfeiffer Big Sur", parkId: park.id, lastScannedAt: new Date() });
    // Scanned, but no free slots stored at all.

    await page.goto(`/search?facilities=${facility.id}&days=5&days=6`);

    await expect(page.getByText("Nothing open for this pattern right now.")).toBeVisible();
    await expect(page.getByText("so there's nothing to search", { exact: false })).toHaveCount(0);
  });

  // A never-scanned facility is stale by definition, so the page renders it as pending and
  // the SSE stream tries to refresh it. RC_API_OFFLINE=1 (playwright.config.ts) makes that
  // attempt fail immediately instead of reaching ReserveCalifornia, so this also covers the
  // stream's failure path: progress resolves, and the row settles on "never scanned" rather
  // than claiming to show older data it doesn't have.
  test("says so when a campground has never been scanned", async ({ page }) => {
    const park = await createPark({ name: "Anza-Borrego" });
    const facility = await createFacility({ name: "Tamarisk Grove", parkId: park.id, lastScannedAt: null });

    await page.goto(`/search?facilities=${facility.id}&days=5&nights=1&bounds=anytime`);

    await expect(page.getByText("so there's nothing to search", { exact: false })).toBeVisible();
    await expect(page.getByText("No data yet — a watch will start the first scan.")).toBeVisible();
    // Starts as "checking now…", then settles once the refresh fails.
    await expect(page.getByText("not scanned yet")).toBeVisible();
    // There is no older data, so it must never claim to be showing any.
    await expect(page.getByText("showing the last data we stored", { exact: false })).toHaveCount(0);
    // The progress bar must not be left spinning forever.
    await expect(page.getByText("Checking ReserveCalifornia", { exact: false })).toHaveCount(0);
  });
});

// A search whose campgrounds are all fresh has nothing to refresh, so the page must not
// open a progress stream at all — no progress bar, no ReserveCalifornia calls.
test.describe("search page — progress stream", () => {
  test("shows no progress bar when every campground is already fresh", async ({ page }) => {
    const park = await createPark({ name: "Point Reyes" });
    const facility = await createFacility({ name: "Sky Camp", parkId: park.id, lastScannedAt: new Date() });

    await page.goto(`/search?facilities=${facility.id}&days=5&nights=1&bounds=anytime`);

    await expect(page.getByText("Nothing open for this pattern right now.")).toBeVisible();
    await expect(page.getByText("Checking ReserveCalifornia", { exact: false })).toHaveCount(0);
  });

  test("streams progress and clears it when the refresh finishes", async ({ page }) => {
    const park = await createPark({ name: "Julia Pfeiffer Burns" });
    // Older than FRESHNESS_MS (5 min), so the page opens the stream on load.
    const facility = await createFacility({
      name: "Environmental Camp",
      parkId: park.id,
      lastScannedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    await page.goto(`/search?facilities=${facility.id}&days=5&nights=1&bounds=anytime`);

    // The refresh fails fast (RC_API_OFFLINE), so the stream reports it as stale
    // and takes the progress bar away rather than hanging.
    await expect(page.getByText("We couldn't reach ReserveCalifornia for Environmental Camp")).toBeVisible();
    await expect(page.getByText("Checking ReserveCalifornia", { exact: false })).toHaveCount(0);
  });
});

// The geocoder proxies to OpenStreetMap Nominatim (external, rate-limited to 1 req/sec).
// Only the short-query validation path is safe to test — it returns before any network call.
test.describe("geocode endpoint", () => {
  test("returns 422 for a too-short query without calling the external geocoder", async ({ page }) => {
    const response = await page.request.get("/api/geocode?q=NY");
    expect(response.status()).toBe(422);
    const body = await response.json();
    expect(body.error).toBe("Enter a city, ZIP, or address.");
  });

  test("returns 422 when q is missing entirely", async ({ page }) => {
    const response = await page.request.get("/api/geocode");
    expect(response.status()).toBe(422);
  });
});
