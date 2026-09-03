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

    // Fri + Sat are pre-checked; keep that and just change nights. A watch has no
    // date bounds — it always covers the full rolling booking window.
    await page.getByLabel("Nights").fill("2");
    await page.getByRole("button", { name: "Create watch" }).click();

    await expect(page).toHaveURL(/\/watches$/);
    await expect(page.getByText("Yosemite", { exact: true })).toBeVisible();
    await expect(page.getByText("Upper Pines")).toBeVisible();
    await expect(page.getByText("Check-in Fri, Sat · 2 nights · anytime in the booking window")).toBeVisible();
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

  test("offers no date bounds — a watch always covers the whole window", async ({ page }) => {
    const park = await createPark({ name: "Death Valley" });
    await createFacility({ name: "Furnace Creek", parkId: park.id });

    await page.goto("/watches/new");

    await expect(page.locator("#startDate")).toHaveCount(0);
    await expect(page.locator("#endDate")).toHaveCount(0);
    await expect(page.getByText("Only between specific dates")).toHaveCount(0);
    await expect(page.getByText("rolls forward as ReserveCalifornia opens new dates", { exact: false })).toBeVisible();
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
    // toHaveCount(0) asserts the row is gone. not.toBeVisible() passes for an
    // element that is merely off-screen or mid-rerender, which made this flake.
    await expect(page.getByText("Sequoia Loop")).toHaveCount(0);
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

// A watch is swept hourly forever, so it carries a tighter cap than a one-off search.
test.describe("watch limits", () => {
  test.use({ user: { email: "capped@example.com", firstName: "Cap", lastName: "Ped" } });

  test("rejects a watch covering more campgrounds than the cap", async ({ page }) => {
    const park = await createPark({ name: "Anza-Borrego" });
    const ids: string[] = [];
    for (let i = 0; i < 21; i++) {
      const facility = await createFacility({ name: `Camp ${i}`, parkId: park.id });
      ids.push(facility.id);
    }

    // `facilityIds` repeats once per campground, which Playwright's `form` option
    // (a plain object) can't express — build the urlencoded body by hand.
    const body = new URLSearchParams();
    for (const id of ids) body.append("facilityIds", id);
    body.append("checkinDays", "5");
    body.append("nights", "1");

    const response = await page.request.post("/watches/new", {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      data: body.toString(),
    });

    expect(response.status()).toBe(200);
    expect(await response.text()).toContain("at most 20 campgrounds");
    expect(await prisma.watch.count()).toBe(0);
  });
});

// One active watch per user while scanning is a single in-process loop.
test.describe("one watch per user", () => {
  test.use({ user: { email: "onewatch@example.com", firstName: "One", lastName: "Watch" } });

  test("refuses a second watch and allows one again after deleting", async ({ page }) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email: "onewatch@example.com" } });
    const park = await createPark({ name: "Mount Diablo" });
    const facility = await createFacility({ name: "Live Oak", parkId: park.id });
    const watch = await createWatch({ userId: user.id, facilityIds: facility.id, active: true });

    const submit = () => {
      const body = new URLSearchParams();
      body.append("facilityIds", facility.id);
      body.append("checkinDays", "5");
      body.append("nights", "1");
      body.append("bounds", "anytime");
      return page.request.post("/watches/new", {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        data: body.toString(),
      });
    };

    expect(await (await submit()).text()).toContain("You already have a watch");
    expect(await prisma.watch.count()).toBe(1);

    await prisma.watch.delete({ where: { id: watch.id } });
    await submit();
    expect(await prisma.watch.count()).toBe(1);
  });
});
