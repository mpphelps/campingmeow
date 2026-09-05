import { prisma } from "@campingmeow/database";
import { test, expect } from "../test-fixtures";
import { createPark, createFacility, createWatch, createSlots, nextWeekday, isoDate } from "../utilities/utilities";

/**
 * The availability calendar. Green means two different things by design:
 *
 *  - campground page — any site free that night ("is this date worth a look")
 *  - my watches      — a stay matching your pattern can START here
 *
 * The second is the one that must not lie: a green Friday you can't actually
 * book for your two nights is worse than showing nothing.
 */
test.describe("campground calendar", () => {
  test.use({ user: null });

  test("marks nights with a free site, and says when it was last checked", async ({ page }) => {
    const park = await createPark({ name: "Angel Island SP" });
    const facility = await createFacility({
      name: "Ayala Cove",
      parkId: park.id,
      lastScannedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const fri = nextWeekday(5);
    await createSlots({ facilityId: facility.id, unitName: "Site 1", dates: [fri] });

    await page.goto(`/parks/${park.id}/${facility.id}`);

    await expect(page.getByRole("heading", { name: "Ayala Cove" })).toBeVisible();
    await expect(page.getByText("At least one site free that night")).toBeVisible();
    await expect(page.getByText("Last checked 1h ago")).toBeVisible();
    await expect(page.getByRole("link", { name: "Watch" })).toBeVisible();

    // The seeded night is marked; the day after it is not.
    const marked = page.locator("td.\\[\\&\\>div\\]\\:bg-primary\\/15, td").filter({ hasText: String(fri.getUTCDate()) });
    await expect(marked.first()).toBeVisible();
  });

  test("a never-scanned campground says so instead of showing an empty month", async ({ page }) => {
    const park = await createPark({ name: "Unscanned SP" });
    const facility = await createFacility({ name: "No Data Camp", parkId: park.id, lastScannedAt: null });

    await page.goto(`/parks/${park.id}/${facility.id}`);

    await expect(page.getByText("We haven't checked this campground yet")).toBeVisible();
    await expect(page.getByRole("grid")).toHaveCount(0);
  });

  test("404s for an unknown campground", async ({ page }) => {
    const park = await createPark({ name: "Somewhere" });
    const response = await page.goto(`/parks/${park.id}/does-not-exist`);
    expect(response?.status()).toBe(404);
  });

  test("the park page links each campground to its calendar", async ({ page }) => {
    const park = await createPark({ name: "Big Basin" });
    const facility = await createFacility({ name: "Huckleberry", parkId: park.id });

    await page.goto(`/parks/${park.id}`);
    await page.getByRole("link", { name: "Availability" }).click();

    await expect(page).toHaveURL(new RegExp(`/parks/${park.id}/${facility.id}$`));
  });
});

test.describe("watch calendar", () => {
  test.use({ user: { email: "cal@example.com", firstName: "Cal", lastName: "Endar" } });

  test("only marks days a full matching stay can start on", async ({ page }) => {
    const park = await createPark({ name: "Point Reyes" });
    const facility = await createFacility({ name: "Sky Camp", parkId: park.id, lastScannedAt: new Date() });

    // Two Fridays. The first has Saturday free too, the second does not — so a
    // Friday + 2 nights watch can only start on the first.
    const friA = nextWeekday(5);
    const satA = new Date(friA);
    satA.setUTCDate(satA.getUTCDate() + 1);
    const friB = new Date(friA);
    friB.setUTCDate(friB.getUTCDate() + 7);

    await createSlots({ facilityId: facility.id, unitId: 1, unitName: "Site 1", dates: [friA, satA] });
    await createSlots({ facilityId: facility.id, unitId: 1, unitName: "Site 1", dates: [friB] });

    // The `user` fixture already created this row by logging in.
    const dbUser = await prisma.user.findUniqueOrThrow({ where: { email: "cal@example.com" } });
    await createWatch({ userId: dbUser.id, facilityIds: facility.id, checkinDays: [5], nights: 2 });

    await page.goto("/watches");

    await expect(page.getByText("A stay matching your watch can start here")).toBeVisible();

    // The available modifier lands on the day cell (it styles the inner wrapper
    // via a `[&>div]:` rule), so the cell's class is what to assert on.
    const cell = (date: Date) =>
      page.locator("td").filter({ hasText: new RegExp(`^${date.getUTCDate()}$`) }).first();

    await expect(cell(friA)).toHaveClass(/bg-primary/);
    await expect(cell(friB)).not.toHaveClass(/bg-primary/);
    expect(isoDate(friA)).not.toBe(isoDate(friB));
  });
});
