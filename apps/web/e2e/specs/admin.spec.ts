import { prisma } from "@campingmeow/database";
import type { Page } from "@playwright/test";
import { test, expect } from "../test-fixtures";
import { createOwnerUser, createPark, createFacility, createWatch } from "../utilities/utilities";

/** Reads the numeric value shown on a stat card identified by its exact label (e.g. "Users", "Active watches"). */
function statCardValue(page: Page, label: string) {
  const labelDiv = page.locator("div.mt-1.text-xs.text-muted-foreground").filter({ hasText: new RegExp(`^${label}$`) });
  return labelDiv.locator("xpath=preceding-sibling::div[1]");
}

test.describe("admin dashboard", () => {
  test.use({ user: { email: "admin@example.com", firstName: "Admin", lastName: "User", permissions: ["admin:site"] } });

  test("shows stat cards and the users table for an admin", async ({ page }) => {
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: "admin@example.com" } });
    const viewer = await createOwnerUser({ email: "viewer@example.com", firstName: "View", lastName: "Er" });

    const activePark = await createPark({ name: "Sequoia", active: true });
    await createPark({ name: "Retired Park", active: false });

    const activeFacility = await createFacility({ name: "Lodgepole", parkId: activePark.id, active: true });
    await createFacility({ name: "Old Site", parkId: activePark.id, active: false });

    // Two active watches on the same facility (admin + viewer) — should count as 1 watched campground.
    await createWatch({ userId: admin.id, facilityIds: activeFacility.id, active: true });
    await createWatch({ userId: viewer.id, facilityIds: activeFacility.id, active: true });
    // An inactive watch that must be excluded from all counts.
    await createWatch({ userId: admin.id, facilityIds: activeFacility.id, active: false });

    await page.goto("/admin");

    await expect(page.getByRole("heading", { name: "Admin", level: 1 })).toBeVisible();

    await expect(statCardValue(page, "Users")).toHaveText("2");
    await expect(statCardValue(page, "Parks")).toHaveText("1");
    await expect(statCardValue(page, "Campgrounds")).toHaveText("1");
    await expect(statCardValue(page, "Active watches")).toHaveText("2");
    await expect(statCardValue(page, "Watched campgrounds")).toHaveText("1");

    await expect(page.getByText("Catalog sync", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sync catalog now" })).toBeVisible();
    // NOTE: intentionally not clicking "Sync catalog now" — it calls the real ReserveCalifornia API.

    await expect(page.getByText("Availability sweep", { exact: true })).toBeVisible();
    // Counts mirror the stat cards above: 1 watched campground, 1 active campground total.
    await expect(page.getByRole("button", { name: "Scan watched (1)" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Full sweep — all 1" })).toBeVisible();
    // NOTE: intentionally not clicking either — both kick off real scans in the background.

    const table = page.locator("table");
    const adminRow = table.locator("tr", { hasText: "admin@example.com" });
    await expect(adminRow.locator("td").nth(1)).toHaveText("Admin User");
    await expect(adminRow.locator("td").nth(2)).toHaveText("1"); // one active watch (inactive one excluded)

    const viewerRow = table.locator("tr", { hasText: "viewer@example.com" });
    await expect(viewerRow.locator("td").nth(1)).toHaveText("View Er");
    await expect(viewerRow.locator("td").nth(2)).toHaveText("1");
  });
});

test.describe("admin access control", () => {
  test.use({ user: { email: "regular@example.com", firstName: "Regular", lastName: "User" } });

  test("returns 403 for a logged-in user without admin:site", async ({ page }) => {
    const response = await page.goto("/admin");
    expect(response?.status()).toBe(403);
    // admin.tsx now renders its own PageErrorBoundary (no role="alert" container);
    // it shows ErrorLookup's micro-label as an h1 (a matching toast also fires, but
    // the toast title isn't a heading, so this stays unambiguous).
    await expect(page.getByRole("heading", { name: "Access denied" })).toBeVisible();
  });
});

test.describe("admin access control — logged out", () => {
  test.use({ user: null });

  test("redirects to login", async ({ page }) => {
    const response = await page.request.get("/admin", { maxRedirects: 0 });
    expect(response.status()).toBeGreaterThanOrEqual(300);
    expect(response.status()).toBeLessThan(400);
    expect(response.headers()["location"]).toBe("/auth/login");
  });
});

test.describe("catalog sync endpoint", () => {
  test.use({ user: null });

  test("returns 401 when logged out", async ({ page }) => {
    const response = await page.request.post("/api/catalog-sync");
    expect(response.status()).toBe(401);
  });
});

test.describe("catalog sync endpoint — non-admin", () => {
  test.use({ user: { email: "noperm@example.com", firstName: "No", lastName: "Perm" } });

  test("returns 403 for a logged-in user without admin:site", async ({ page }) => {
    const response = await page.request.post("/api/catalog-sync");
    expect(response.status()).toBe(403);
  });
});

// startSweep checks the admin permission before touching any campground, so non-admin/logged-out
// requests never reach ReserveCalifornia. A 200 response would kick off a real background sweep
// of every watched (or every catalog) campground, so that path is intentionally not exercised here.
test.describe("scan-watched endpoint", () => {
  test.use({ user: null });

  test("returns 401 when logged out", async ({ page }) => {
    const response = await page.request.post("/api/scan-watched");
    expect(response.status()).toBe(401);
  });
});

test.describe("scan-watched endpoint — non-admin", () => {
  test.use({ user: { email: "noperm2@example.com", firstName: "No", lastName: "Perm" } });

  test("returns 403 for a logged-in user without admin:site", async ({ page }) => {
    // The action reads `scope` from formData before checking permission, so a bodyless
    // request 500s trying to parse it — send a real form body, as the UI always would.
    const response = await page.request.post("/api/scan-watched", { form: { scope: "watched" } });
    expect(response.status()).toBe(403);
  });
});
