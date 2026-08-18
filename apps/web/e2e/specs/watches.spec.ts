import { prisma } from "@campingmeow/database";
import { test, expect } from "../test-fixtures";
import { createOwnerUser, createPark, createFacility, createWatch } from "../utilities/utilities";

test.describe("watches", () => {
  test.use({ user: { email: "watcher@example.com", firstName: "Watcher", lastName: "User" } });

  test("creates a watch from the park detail page and shows it on the watches list", async ({ page }) => {
    const park = await createPark({ name: "Yosemite", city: "Yosemite Village" });
    const facility = await createFacility({ name: "Upper Pines", parkId: park.id });

    await page.goto(`/parks/${park.id}`);
    await page.getByRole("link", { name: "Watch", exact: true }).click();

    await expect(page).toHaveURL(new RegExp(`/watches/new\\?facilityId=${facility.id}`));
    await expect(page.getByRole("heading", { name: "New watch" })).toBeVisible();

    // The campground referred from the park page is pre-checked in the picker.
    await expect(page.getByLabel("Yosemite · Upper Pines")).toHaveAttribute("aria-checked", "true");

    // Fri + Sat are pre-checked; keep that, just change nights and add date bounds.
    await page.getByLabel("Nights").fill("2");
    // Radix RadioGroupItem/Checkbox render as <button role="checkbox|radio">, not native
    // inputs — .check()/.uncheck() can silently no-op on them, so use .click() + aria-checked.
    await page.getByLabel("Only between specific dates").click();
    await page.locator("#startDate").fill("2026-09-01");
    await page.locator("#endDate").fill("2026-09-30");
    await page.getByRole("button", { name: "Create watch" }).click();

    await expect(page).toHaveURL(/\/watches$/);
    await expect(page.getByText("Yosemite", { exact: true })).toBeVisible();
    await expect(page.getByText("Upper Pines")).toBeVisible();
    await expect(page.getByText("Check-in Fri, Sat · 2 nights · 2026-09-01 → 2026-09-30")).toBeVisible();
  });

  test("creates a watch covering multiple campgrounds across parks", async ({ page }) => {
    const parkA = await createPark({ name: "Sequoia" });
    const parkB = await createPark({ name: "Kings Canyon" });
    const facilityA = await createFacility({ name: "Lodgepole", parkId: parkA.id });
    const facilityB = await createFacility({ name: "Sentinel", parkId: parkB.id });

    await page.goto("/watches/new");
    await expect(page.getByRole("heading", { name: "New watch" })).toBeVisible();

    await page.getByLabel(`${parkA.name} · ${facilityA.name}`).click();
    await page.getByLabel(`${parkB.name} · ${facilityB.name}`).click();
    await page.getByRole("button", { name: "Create watch" }).click();

    await expect(page).toHaveURL(/\/watches$/);
    await expect(page.getByText("Sequoia", { exact: true })).toBeVisible();
    await expect(page.getByText("Lodgepole")).toBeVisible();
    await expect(page.getByText("Kings Canyon", { exact: true })).toBeVisible();
    await expect(page.getByText("Sentinel")).toBeVisible();
  });

  test("only reveals date inputs when a specific date range is chosen", async ({ page }) => {
    const park = await createPark({ name: "Death Valley" });
    await createFacility({ name: "Furnace Creek", parkId: park.id });

    await page.goto("/watches/new");

    // "Anytime in the booking window" is the default — no date inputs rendered.
    await expect(page.locator("#startDate")).toHaveCount(0);
    await expect(page.locator("#endDate")).toHaveCount(0);

    await page.getByLabel("Only between specific dates").click();
    await expect(page.locator("#startDate")).toBeVisible();
    await expect(page.locator("#endDate")).toBeVisible();

    await page.getByLabel("Anytime in the booking window").click();
    await expect(page.locator("#startDate")).toHaveCount(0);
    await expect(page.locator("#endDate")).toHaveCount(0);
  });

  test("shows a validation error when no check-in days are selected", async ({ page }) => {
    const park = await createPark({ name: "Anza-Borrego" });
    const facility = await createFacility({ name: "Borrego Palm Canyon", parkId: park.id });

    await page.goto(`/watches/new?facilityId=${facility.id}`);
    // Fri + Sat are pre-checked by default; click to uncheck both.
    await page.getByLabel("Fri").click();
    await page.getByLabel("Sat").click();
    await page.getByRole("button", { name: "Create watch" }).click();

    await expect(page.getByText("Pick at least one check-in day.")).toBeVisible();
    await expect(page).toHaveURL(/\/watches\/new/);
  });

  test("shows a validation error when no campgrounds are selected", async ({ page }) => {
    const park = await createPark({ name: "Mount Tamalpais" });
    await createFacility({ name: "Steep Ravine", parkId: park.id });

    await page.goto("/watches/new");
    await page.getByRole("button", { name: "Create watch" }).click();

    await expect(page.getByText("Pick at least one campground.")).toBeVisible();
    await expect(page).toHaveURL(/\/watches\/new/);
  });

  test("shows an empty state when the user has no watches", async ({ page }) => {
    await page.goto("/watches");
    await expect(page.getByText("No watches yet.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Browse parks" })).toHaveAttribute("href", "/parks");
  });

  test("deletes a watch and removes it from the list", async ({ page }) => {
    const dbUser = await prisma.user.findUniqueOrThrow({ where: { email: "watcher@example.com" } });
    const park = await createPark({ name: "Big Basin" });
    const facility = await createFacility({ name: "Sequoia Loop", parkId: park.id });
    await createWatch({ userId: dbUser.id, facilityIds: facility.id });

    await page.goto("/watches");
    await expect(page.getByText("Sequoia Loop")).toBeVisible();

    await page.getByRole("button", { name: "Delete" }).click();

    await expect(page.getByText("No watches yet.")).toBeVisible();
    await expect(page.getByText("Sequoia Loop")).not.toBeVisible();
  });
});

test.describe("watches — logged out", () => {
  test.use({ user: null });

  test("redirects to login", async ({ page }) => {
    // /auth/login itself redirects on to Auth0, which isn't reachable in this test env,
    // so we inspect the raw redirect response from /watches instead of following it.
    const response = await page.request.get("/watches", { maxRedirects: 0 });
    expect(response.status()).toBeGreaterThanOrEqual(300);
    expect(response.status()).toBeLessThan(400);
    expect(response.headers()["location"]).toBe("/auth/login");
  });
});

test.describe("watches — cross-user authorization", () => {
  test.use({ user: { email: "userA@example.com", firstName: "Alice", lastName: "A" } });

  test("returns 403 when deleting another user's watch", async ({ page }) => {
    const userB = await createOwnerUser({ email: "userB@example.com", firstName: "Bob", lastName: "B" });
    const park = await createPark({ name: "Joshua Tree" });
    const facility = await createFacility({ name: "Hidden Valley", parkId: park.id });
    const watchB = await createWatch({ userId: userB.id, facilityIds: facility.id });

    const response = await page.request.post("/watches", {
      form: { intent: "delete", watchId: watchB.id },
    });

    expect(response.status()).toBe(403);

    const stillExists = await prisma.watch.findUnique({ where: { id: watchB.id } });
    expect(stillExists).not.toBeNull();
  });
});
