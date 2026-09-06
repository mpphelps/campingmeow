import { test, expect } from "../test-fixtures";
import { createPark, createFacility, createSlots, nextWeekday, isoDate } from "../utilities/utilities";

/**
 * "I want to go camping — where can I go?"
 *
 * The page is addressed by lat/lng in the URL, so these drive it directly and
 * never touch the geocoder. That is also what makes a result shareable.
 */

// Santa Cruz, CA.
const FROM = { lat: 36.9741, lng: -122.0308 };
// ~30 miles away (Big Basin-ish) and ~250 miles away (Sierra-ish).
const NEAR = { latitude: 37.1722, longitude: -122.2222 };
const FAR = { latitude: 39.3, longitude: -120.2 };

function url(params: Record<string, string> = {}) {
  const search = new URLSearchParams({ lat: String(FROM.lat), lng: String(FROM.lng), ...params });
  return `/available-nearby?${search}`;
}

test.describe("available nearby", () => {
  test.use({ user: null });

  test("prompts for a location before showing anything", async ({ page }) => {
    await page.goto("/available-nearby");

    await expect(page.getByText("Tell us where you're starting from", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Use my location" })).toBeVisible();
  });

  test("shows campgrounds in range with a free night, and hides the ones out of range", async ({ page }) => {
    const near = await createPark({ name: "Big Basin Redwoods", ...NEAR });
    const nearFacility = await createFacility({ name: "Huckleberry", parkId: near.id, lastScannedAt: new Date() });
    await createSlots({ facilityId: nearFacility.id, dates: [nextWeekday(5)] });

    const far = await createPark({ name: "Donner Memorial", ...FAR });
    const farFacility = await createFacility({ name: "Splitrock", parkId: far.id, lastScannedAt: new Date() });
    await createSlots({ facilityId: farFacility.id, dates: [nextWeekday(5)] });

    await page.goto(url({ radius: "50" }));

    await expect(page.getByRole("link", { name: "Huckleberry" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Splitrock" })).toHaveCount(0);
  });

  /**
   * A campground with nothing free for nine weeks is dropped, not shown as an
   * empty row — a screen of grey is noise. We still say how many we checked.
   */
  test("hides fully booked campgrounds but reports how many", async ({ page }) => {
    const park = await createPark({ name: "Henry Cowell", ...NEAR });
    const open = await createFacility({ name: "Open Camp", parkId: park.id, lastScannedAt: new Date() });
    await createSlots({ facilityId: open.id, dates: [nextWeekday(5)] });

    const booked = await createFacility({ name: "Booked Camp", parkId: park.id, lastScannedAt: new Date() });
    await createSlots({ facilityId: booked.id, dates: [nextWeekday(5)], isFree: false });

    await page.goto(url());

    await expect(page.getByRole("link", { name: "Open Camp" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Booked Camp" })).toHaveCount(0);
    await expect(page.getByText("1 fully booked and hidden", { exact: false })).toBeVisible();
  });

  test("filters by type of camping", async ({ page }) => {
    const park = await createPark({ name: "Cuyamaca", ...NEAR });
    const tents = await createFacility({
      name: "Tent Loop",
      parkId: park.id,
      lastScannedAt: new Date(),
      siteCategories: [1],
    });
    await createSlots({ facilityId: tents.id, dates: [nextWeekday(5)] });

    const cabins = await createFacility({
      name: "Cabin Row",
      parkId: park.id,
      lastScannedAt: new Date(),
      siteCategories: [1008],
    });
    await createSlots({ facilityId: cabins.id, dates: [nextWeekday(5)] });

    await page.goto(url({ types: "1008" }));

    await expect(page.getByRole("link", { name: "Cabin Row" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Tent Loop" })).toHaveCount(0);
  });

  test("marks the nights a site is free and leaves the rest blank", async ({ page }) => {
    const friday = nextWeekday(5);
    const park = await createPark({ name: "Portola Redwoods", ...NEAR });
    const facility = await createFacility({ name: "Sequoia Loop", parkId: park.id, lastScannedAt: new Date() });
    await createSlots({ facilityId: facility.id, dates: [friday] });

    await page.goto(url());

    // The free night is announced with a count; a neighbouring night is not.
    await expect(page.getByText(new RegExp(`${isoDate(friday).slice(5)}|1 free`)).first()).toBeVisible();
    await expect(page.getByTitle(/1 site free/)).toBeVisible();
  });

  test("selecting campgrounds offers a watch", async ({ page }) => {
    const park = await createPark({ name: "Butano", ...NEAR });
    const facility = await createFacility({ name: "Ben Ries", parkId: park.id, lastScannedAt: new Date() });
    await createSlots({ facilityId: facility.id, dates: [nextWeekday(5)] });

    await page.goto(url());

    await expect(page.getByRole("link", { name: "Watch these" })).toHaveCount(0);
    await page.getByLabel("Select Ben Ries").check();

    const watch = page.getByRole("link", { name: "Watch these" });
    await expect(watch).toBeVisible();
    await expect(watch).toHaveAttribute("href", `/watches/new?facilities=${facility.id}`);
  });

  test("says so when nothing is free in range", async ({ page }) => {
    const park = await createPark({ name: "Empty SP", ...NEAR });
    await createFacility({ name: "Nothing Here", parkId: park.id, lastScannedAt: new Date() });

    await page.goto(url());

    await expect(page.getByText("Nothing free within 50 miles", { exact: false })).toBeVisible();
  });

  test("rejects an absurd radius rather than scanning the state", async ({ page }) => {
    await page.goto(url({ radius: "9000" }));

    await expect(page.getByText("Pick a distance between 1 and 500 miles")).toBeVisible();
  });

  test("is reachable from the nav signed out", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Available nearby" }).first().click();

    await expect(page.getByRole("heading", { name: "Available near you" })).toBeVisible();
  });
});
