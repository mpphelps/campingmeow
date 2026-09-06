import { test, expect } from "../test-fixtures";
import { createPark, createFacility, createSlots, nextWeekday, isoDate } from "../utilities/utilities";

// /search reads ONLY our database (AvailabilitySlot rows) — it never calls
// ReserveCalifornia. Data gets there via the nightly full-catalog sweep and the
// watched-campground sweeps, so tests seed rows directly. The suite also runs with
// RC_API_OFFLINE=1 and DISABLE_SCHEDULER=1 (playwright.config.ts) so nothing a test
// triggers can reach the live API.
test.describe("search page — form only", () => {
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

    await expect(page.getByText("Nothing open for this pattern as of the last sweep.")).toBeVisible();
    await expect(page.getByText("so there's nothing to search", { exact: false })).toHaveCount(0);
  });

  // Nothing has ever scanned this campground, so we have no rows for it — saying
  // "nothing open" would be a lie.
  test("says so when a campground has never been scanned", async ({ page }) => {
    const park = await createPark({ name: "Anza-Borrego" });
    const facility = await createFacility({ name: "Tamarisk Grove", parkId: park.id, lastScannedAt: null });

    await page.goto(`/search?facilities=${facility.id}&days=5&nights=1&bounds=anytime`);

    await expect(page.getByText("so there's nothing to search", { exact: false })).toBeVisible();
    await expect(page.getByText("No data yet — this campground is in the next sweep.")).toBeVisible();
    await expect(page.getByText("not scanned yet")).toBeVisible();
    await expect(page.getByText("We haven't scanned these campgrounds yet.")).toBeVisible();
  });
});


// The geocoder proxies to OpenStreetMap Nominatim (external, rate-limited to 1 req/sec).
// Only the short-query validation path is safe to test — it returns before any network call.
test.describe("geocode endpoint", () => {
  test.use({ user: { email: "geo@example.com", firstName: "Geo", lastName: "Coder" } });

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

// Search no longer spends API budget, so the cap only bounds one query and one page of
// results — but it still has to hold against a hand-edited URL. See app/lib/limits.ts.
test.describe("search limits", () => {
  test("refuses a search over the campground cap and offers a way out", async ({ page }) => {
    const park = await createPark({ name: "Big Basin" });
    const ids: string[] = [];
    for (let i = 0; i < 51; i++) {
      const facility = await createFacility({ name: `Camp ${i}`, parkId: park.id, lastScannedAt: new Date() });
      ids.push(facility.id);
    }

    await page.goto(`/search?facilities=${ids.join(",")}&days=5&nights=1&bounds=anytime`);

    await expect(page.getByText("Pick at most 50 campgrounds at a time (you picked 51)")).toBeVisible();
    await expect(page.getByRole("link", { name: "watch them all instead" })).toBeVisible();
    // No results block, and nothing was scanned.
    await expect(page.getByText("matching check-in date", { exact: false })).toHaveCount(0);
  });

  test("allows a search exactly at the cap", async ({ page }) => {
    const park = await createPark({ name: "Henry Coe" });
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) {
      const facility = await createFacility({ name: `Site ${i}`, parkId: park.id, lastScannedAt: new Date() });
      ids.push(facility.id);
    }

    await page.goto(`/search?facilities=${ids.join(",")}&days=5&nights=1&bounds=anytime`);

    await expect(page.getByText("matching check-in date", { exact: false })).toBeVisible();
    await expect(page.getByText("Pick at most 50", { exact: false })).toHaveCount(0);
  });
});

// Geocoding still proxies Nominatim, so it stays members-only. Search doesn't spend any
// external budget any more, so it's open to everyone.
test.describe("public access — logged out", () => {
  test.use({ user: null });

  test("geocode returns 401 before calling the external geocoder", async ({ page }) => {
    const response = await page.request.get("/api/geocode?q=Newport%20Beach");
    expect(response.status()).toBe(401);
    expect((await response.json()).authRequired).toBe(true);
  });

  test("search works signed out, and says how old the data is", async ({ page }) => {
    const park = await createPark({ name: "Sugar Pine Point" });
    const facility = await createFacility({
      name: "General Creek",
      parkId: park.id,
      lastScannedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
    });

    await page.goto(`/search?facilities=${facility.id}&days=5&nights=1&bounds=anytime`);

    await expect(page.getByText("matching check-in date", { exact: false })).toBeVisible();
    await expect(page.getByText("Last updated 3h ago")).toBeVisible();
  });
});

