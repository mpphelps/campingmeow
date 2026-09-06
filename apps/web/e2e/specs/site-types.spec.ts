import { test, expect } from "../test-fixtures";
import { createPark, createFacility } from "../utilities/utilities";

/**
 * What kind of camping a campground offers, shown as icons beside its name.
 *
 * The categories come from ReserveCalifornia's `UnitCategoryId`, rolled up onto
 * the Facility by each scan. Measured across 60 campgrounds: seven distinct
 * ids, 83% of campgrounds using exactly one.
 */
test.describe("site type icons", () => {
  test("shows one icon per type on a campground in the park accordion", async ({ page }) => {
    const park = await createPark({ name: "Cuyamaca Rancho" });
    // Paso Picacho really does report both — "Campground & Cabins".
    await createFacility({ name: "Paso Picacho", parkId: park.id, siteCategories: [1, 1008] });

    await page.goto("/");
    await page.getByRole("button", { name: /Cuyamaca Rancho/ }).click();

    // Only one campground exists in this test, so page scope is unambiguous.
    await expect(page.getByTitle("Campsites")).toBeVisible();
    await expect(page.getByTitle("Cabins")).toBeVisible();
  });

  test("shows a single icon for the usual single-type campground", async ({ page }) => {
    const park = await createPark({ name: "Crystal Cove" });
    await createFacility({ name: "Moro Campground", parkId: park.id, siteCategories: [1015] });

    await page.goto("/");
    await page.getByRole("button", { name: /Crystal Cove/ }).click();

    await expect(page.getByTitle("RV hookups")).toBeVisible();
    await expect(page.getByTitle("Campsites")).toHaveCount(0);
  });

  /**
   * A campground we have never scanned has no categories. Showing nothing is
   * right — an icon would claim knowledge we do not have.
   */
  test("shows nothing for a campground with no categories yet", async ({ page }) => {
    const park = await createPark({ name: "Never Scanned SP" });
    await createFacility({ name: "Unknown Camp", parkId: park.id, siteCategories: [] });

    await page.goto("/");
    await page.getByRole("button", { name: /Never Scanned SP/ }).click();

    await expect(page.getByLabel("Select Unknown Camp")).toBeVisible();
    await expect(page.getByTitle("Campsites")).toHaveCount(0);
    await expect(page.getByTitle("Cabins")).toHaveCount(0);
  });

  /**
   * If ReserveCalifornia invents a category we have not mapped, it is dropped
   * rather than guessed at — a wrong icon is worse than no icon.
   */
  test("ignores an unmapped category id but keeps the known ones", async ({ page }) => {
    const park = await createPark({ name: "Future Category SP" });
    await createFacility({ name: "Mixed Camp", parkId: park.id, siteCategories: [1, 99999] });

    await page.goto("/");
    await page.getByRole("button", { name: /Future Category SP/ }).click();

    await expect(page.getByTitle("Campsites")).toBeVisible();
    await expect(page.getByTitle("Cabins")).toHaveCount(0);
  });

  test("shows them on the park page too", async ({ page }) => {
    const park = await createPark({ name: "Big Basin" });
    await createFacility({ name: "Huckleberry", parkId: park.id, siteCategories: [1, 1015] });

    await page.goto(`/parks/${park.id}`);

    await expect(page.getByTitle("Campsites")).toBeVisible();
    await expect(page.getByTitle("RV hookups")).toBeVisible();
  });
});
