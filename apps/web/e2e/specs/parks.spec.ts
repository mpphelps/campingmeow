import { test, expect } from "../test-fixtures";
import { createPark, createFacility } from "../utilities/utilities";

test.describe("home parks browser", () => {
  test("shows empty state when the catalog hasn't been synced", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("No parks yet — the catalog hasn't been synced.")).toBeVisible();
  });

  test("renders seeded parks with facility counts, sorted by name", async ({ page }) => {
    const yosemite = await createPark({ name: "Yosemite", city: "Yosemite Village" });
    const anza = await createPark({ name: "Anza-Borrego", city: "Borrego Springs" });
    await createFacility({ name: "Upper Pines", parkId: yosemite.id });
    await createFacility({ name: "Lower Pines", parkId: yosemite.id });
    await createFacility({ name: "Borrego Palm Canyon", parkId: anza.id });

    await page.goto("/");

    await expect(page.getByText("2 parks")).toBeVisible();

    // Rows are accordion items (packages/ui Accordion) — anchor on the shared component's
    // data-slot attribute rather than the route's own DOM structure.
    const items = page.locator('[data-slot="accordion-item"]');
    await expect(items).toHaveCount(2);
    // Alphabetical order: Anza-Borrego before Yosemite.
    await expect(items.nth(0)).toContainText("Anza-Borrego");
    await expect(items.nth(0)).toContainText("Borrego Springs");
    await expect(items.nth(0)).toContainText("1 campground");
    await expect(items.nth(1)).toContainText("Yosemite");
    await expect(items.nth(1)).toContainText("Yosemite Village");
    await expect(items.nth(1)).toContainText("2 campgrounds");
  });

  test("excludes inactive parks from the list", async ({ page }) => {
    const active = await createPark({ name: "Active Park", active: true });
    const retired = await createPark({ name: "Retired Park", active: false });
    await createFacility({ name: "Site A", parkId: active.id });
    await createFacility({ name: "Site B", parkId: retired.id });

    await page.goto("/");

    await expect(page.getByText("1 park")).toBeVisible();
    await expect(page.getByText("Active Park")).toBeVisible();
    await expect(page.getByText("Retired Park")).toHaveCount(0);
  });

  test("excludes parks with no active campgrounds", async ({ page }) => {
    const withFacility = await createPark({ name: "Sequoia" });
    await createFacility({ name: "Lodgepole", parkId: withFacility.id, active: true });

    await createPark({ name: "Empty Park" });

    const onlyInactive = await createPark({ name: "All Retired Park" });
    await createFacility({ name: "Old Site", parkId: onlyInactive.id, active: false });

    await page.goto("/");

    await expect(page.getByText("1 park")).toBeVisible();
    await expect(page.getByText("Sequoia", { exact: true })).toBeVisible();
    await expect(page.getByText("Empty Park")).toHaveCount(0);
    await expect(page.getByText("All Retired Park")).toHaveCount(0);
  });

  test("filters parks by name as you type (client-side, no navigation)", async ({ page }) => {
    const yosemite = await createPark({ name: "Yosemite", city: "Yosemite Village" });
    const anza = await createPark({ name: "Anza-Borrego", city: "Borrego Springs" });
    await createFacility({ name: "Upper Pines", parkId: yosemite.id });
    await createFacility({ name: "Borrego Palm Canyon", parkId: anza.id });

    await page.goto("/");
    // There's no Search button anymore — filtering happens on every keystroke, client-side.
    await page.getByLabel("Search parks").fill("yose");

    await expect(page).toHaveURL(/\/$/);
    // exact:true avoids matching the city span too — city "Yosemite Village" contains "Yosemite".
    await expect(page.getByText("Yosemite", { exact: true })).toBeVisible();
    await expect(page.getByText("Anza-Borrego")).toHaveCount(0);
  });

  test("?q= seeds the search input's initial value and filters on load, case-insensitively", async ({ page }) => {
    const yosemite = await createPark({ name: "Yosemite", city: "Yosemite Village" });
    const anza = await createPark({ name: "Anza-Borrego", city: "Borrego Springs" });
    await createFacility({ name: "Upper Pines", parkId: yosemite.id });
    await createFacility({ name: "Borrego Palm Canyon", parkId: anza.id });

    await page.goto("/?q=BORREGO");

    await expect(page.getByText("Anza-Borrego")).toBeVisible();
    await expect(page.getByText("Yosemite", { exact: false })).toHaveCount(0);
  });

  test("shows a no-match message when the search has no hits", async ({ page }) => {
    const park = await createPark({ name: "Yosemite" });
    await createFacility({ name: "Upper Pines", parkId: park.id });

    await page.goto("/?q=nonexistentpark");

    await expect(page.getByText("No parks match “nonexistentpark”.")).toBeVisible();
  });

  test("expanding a park row happens inline without navigating away", async ({ page }) => {
    const park = await createPark({ name: "Sequoia" });
    await createFacility({ name: "Lodgepole", parkId: park.id });

    await page.goto("/");
    await expect(page.getByLabel("Select Lodgepole")).toHaveCount(0);

    await page.getByRole("button", { name: "Sequoia", exact: false }).click();

    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByLabel("Select Lodgepole")).toBeVisible();
  });

  test("distance select is disabled until a location is set", async ({ page }) => {
    await page.goto("/");
    // Never actually geocode here — that hits Nominatim, a real external service.
    await expect(page.getByLabel("Distance")).toBeDisabled();
  });

  test("park row shows map and park-info icon links, and an expanded details link", async ({ page }) => {
    const park = await createPark({ name: "Sequoia" });
    await createFacility({ name: "Lodgepole", parkId: park.id });

    await page.goto("/");

    // The map/park-info icon links sit next to the row header, visible without expanding.
    const mapLink = page.getByRole("link", { name: "Sequoia on Google Maps" });
    await expect(mapLink).toHaveAttribute("target", "_blank");
    await expect(mapLink).toHaveAttribute("href", /^https:\/\/www\.google\.com\/maps\/search\//);

    const infoLink = page.getByRole("link", { name: "Sequoia on parks.ca.gov" });
    await expect(infoLink).toHaveAttribute("target", "_blank");
    await expect(infoLink).toHaveAttribute("href", /^https:\/\/www\.google\.com\/search\?q=/);

    // "Park details →" is inside the accordion content, so it needs expanding first.
    await page.getByRole("button", { name: "Sequoia", exact: false }).click();
    await expect(page.getByRole("link", { name: "Park details →" })).toHaveAttribute("href", `/parks/${park.id}`);
  });
});

test.describe("home park selection", () => {
  test.use({ user: { email: "selector@example.com", firstName: "Selector", lastName: "User" } });

  test("selecting campgrounds enables Create watch and scopes the picker to just those campgrounds", async ({ page }) => {
    const parkA = await createPark({ name: "Sequoia" });
    const parkB = await createPark({ name: "Kings Canyon" });
    const facilityA1 = await createFacility({ name: "Lodgepole", parkId: parkA.id });
    await createFacility({ name: "Dorst Creek", parkId: parkA.id }); // left unchecked
    const facilityB1 = await createFacility({ name: "Sentinel", parkId: parkB.id });

    await page.goto("/");

    await expect(page.getByRole("button", { name: "Create watch" })).toBeDisabled();

    // Expand Sequoia and select just one of its two campgrounds.
    await page.getByRole("button", { name: "Sequoia", exact: false }).click();
    await page.getByLabel("Select Lodgepole").click();
    await expect(page.getByRole("button", { name: "Create watch (1)" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Search availability" })).toBeEnabled();

    // Expand Kings Canyon and select its campground.
    await page.getByRole("button", { name: "Kings Canyon", exact: false }).click();
    await page.getByLabel("Select Sentinel").click();
    const createWatchButton = page.getByRole("button", { name: "Create watch (2)" });
    await expect(createWatchButton).toBeEnabled();
    await createWatchButton.click();

    await expect(page).toHaveURL(/\/watches\/new\?facilities=/);
    await expect(page.getByRole("heading", { name: "New watch" })).toBeVisible();

    await expect(page.getByLabel(`${parkA.name} · ${facilityA1.name}`)).toHaveAttribute("aria-checked", "true");
    await expect(page.getByLabel(`${parkB.name} · ${facilityB1.name}`)).toHaveAttribute("aria-checked", "true");
    // Dorst Creek was never individually checked, so the scoped picker excludes it entirely.
    await expect(page.getByLabel(`${parkA.name} · Dorst Creek`)).toHaveCount(0);
  });

  test("park checkbox reflects mixed vs all-selected campground state", async ({ page }) => {
    const park = await createPark({ name: "Sequoia" });
    await createFacility({ name: "Lodgepole", parkId: park.id });
    await createFacility({ name: "Dorst Creek", parkId: park.id });

    await page.goto("/");

    const parkCheckbox = page.getByLabel("Select Sequoia");
    await expect(parkCheckbox).toHaveAttribute("aria-checked", "false");

    await page.getByRole("button", { name: "Sequoia", exact: false }).click();
    await page.getByLabel("Select Lodgepole").click();

    await expect(parkCheckbox).toHaveAttribute("aria-checked", "mixed");
    await expect(page.getByLabel("Select Dorst Creek")).toHaveAttribute("aria-checked", "false");

    // Checking the park checkbox selects every campground under it.
    await parkCheckbox.click();
    await expect(page.getByLabel("Select Lodgepole")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByLabel("Select Dorst Creek")).toHaveAttribute("aria-checked", "true");
    await expect(parkCheckbox).toHaveAttribute("aria-checked", "true");

    // Unchecking the park checkbox clears every campground under it.
    await parkCheckbox.click();
    await expect(page.getByLabel("Select Lodgepole")).toHaveAttribute("aria-checked", "false");
    await expect(page.getByLabel("Select Dorst Creek")).toHaveAttribute("aria-checked", "false");
  });
});

test.describe("parks redirect", () => {
  test("GET /parks redirects to the home page", async ({ page }) => {
    await page.goto("/parks");
    await expect(page).toHaveURL(/\/$/);
  });

  test("GET /parks?q=... preserves the query when redirecting", async ({ page }) => {
    await page.goto("/parks?q=yose");
    await expect(page).toHaveURL(/\/\?q=yose$/);
  });
});

test.describe("park detail", () => {
  test("shows the park's active facilities and excludes inactive ones", async ({ page }) => {
    const park = await createPark({ name: "Yosemite", city: "Yosemite Village" });
    await createFacility({ name: "Upper Pines", parkId: park.id, active: true });
    await createFacility({ name: "Retired Campground", parkId: park.id, active: false });

    await page.goto(`/parks/${park.id}`);

    await expect(page.getByRole("heading", { name: "Yosemite" })).toBeVisible();
    await expect(page.getByText("Yosemite Village, CA")).toBeVisible();
    await expect(page.getByText("Upper Pines")).toBeVisible();
    await expect(page.getByText("Retired Campground")).toHaveCount(0);
  });

  test("returns 404 for an unknown park id", async ({ page }) => {
    const response = await page.goto("/parks/does-not-exist");
    expect(response?.status()).toBe(404);
    // parks.$parkId.tsx now renders its own PageErrorBoundary (no role="alert" container);
    // it shows ErrorLookup's micro-label as an h1 instead.
    await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
  });

  test("returns 404 for an inactive park", async ({ page }) => {
    const park = await createPark({ name: "Retired Park", active: false });

    const response = await page.goto(`/parks/${park.id}`);
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
  });
});

// A watch commits us to scanning its campgrounds forever, so the home page caps selection
// at the watch limit. See app/lib/limits.ts for where the numbers come from.
test.describe("home page selection limits", () => {
  test("refuses to select past the watch cap of 20", async ({ page }) => {
    const park = await createPark({ name: "Big Basin Redwoods" });
    for (let i = 0; i < 21; i++) {
      // Zero-padded so "Camp 01" never also matches "Camp 010".
      await createFacility({ name: `Camp ${String(i).padStart(2, "0")}`, parkId: park.id });
    }

    await page.goto("/");
    await page.getByLabel(`Select ${park.name}`).click();

    // Ticking the whole park (21) would blow the cap, so nothing is selected.
    // Radix renders each toast twice — once visibly, once in an aria-live region.
    await expect(page.getByText("That's the limit — 20 campgrounds").first()).toBeVisible();
    await expect(page.getByText("campgrounds selected", { exact: false })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Create watch" })).toBeDisabled();

    await page.getByRole("button", { name: `${park.name}`, exact: false }).first().click();

    for (let i = 0; i < 10; i++) {
      await page.getByLabel(`Select Camp ${String(i).padStart(2, "0")}`).click();
    }
    await expect(page.getByText("10 of 20 campgrounds selected")).toBeVisible();
    await expect(page.getByRole("button", { name: "Search availability" })).toBeEnabled();

    // Search reads our database, so it stays available all the way to the cap.
    await page.getByLabel("Select Camp 10").click();
    await expect(page.getByText("11 of 20 campgrounds selected")).toBeVisible();
    await expect(page.getByRole("button", { name: "Search availability" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Create watch (11)" })).toBeEnabled();

    for (let i = 11; i < 20; i++) {
      await page.getByLabel(`Select Camp ${String(i).padStart(2, "0")}`).click();
    }
    await expect(page.getByText("20 of 20 campgrounds selected")).toBeVisible();

    // The 21st is refused outright, with a toast explaining why.
    await page.getByLabel("Select Camp 20").click();
    await expect(page.getByText("That's the limit — 20 campgrounds").first()).toBeVisible();
    await expect(page.getByText("20 of 20 campgrounds selected")).toBeVisible();
    await expect(page.getByLabel("Select Camp 20")).toHaveAttribute("aria-checked", "false");
  });
});

// ReserveCalifornia returns city casing inconsistently ("BORREGO SPRINGS" next to
// "Carpinteria"). The service normalises it so rows don't look like they're set in
// two different faces — uppercase mono reads very differently from lowercase.
test.describe("city formatting", () => {
  test("normalises inconsistent city casing from the source data", async ({ page }) => {
    // Parks with no active campgrounds are excluded from the browse list.
    const shouty = await createPark({ name: "Shouty Park", city: "BORREGO SPRINGS" });
    const polite = await createPark({ name: "Polite Park", city: "Carpinteria" });
    await createFacility({ name: "Shouty Camp", parkId: shouty.id });
    await createFacility({ name: "Polite Camp", parkId: polite.id });

    await page.goto("/");

    // Regex, not a string: getByText(string) matches case-INsensitively, so a
    // string assertion here would pass against the very casing it's meant to catch.
    await expect(page.getByText(/Borrego Springs/)).toBeVisible();
    await expect(page.getByText(/BORREGO SPRINGS/)).toHaveCount(0);
    await expect(page.getByText(/Carpinteria/)).toBeVisible();
  });
});
