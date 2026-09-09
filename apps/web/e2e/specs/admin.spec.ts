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

    // The scanner runs itself; the panel reports health rather than offering buttons.
    await expect(page.getByText("Scanner", { exact: true })).toBeVisible();
    // Both the scanner and the notifier render "Stopped" in tests, so scope the
    // assertion to the Status field rather than matching bare text twice.
    const statusValue = page.locator("dt", { hasText: /^Status$/ }).locator("xpath=following-sibling::dd[1]");
    await expect(statusValue).toHaveText("Stopped"); // DISABLE_SCANNER=1 in tests

    // Every bookable campground is scanned every pass, so cycle duration is the
    // health metric — there is no staleness or backlog to report.
    const lastCycle = page.locator("dt", { hasText: /^Last cycle$/ }).locator("xpath=following-sibling::dd[1]");
    await expect(lastCycle).toHaveText("in progress"); // DISABLE_SCANNER=1, so no cycle has run

    // Progress is what tells a stalled sweep from a slow one, so it is shown
    // even with nothing running — as "—" rather than a misleading 0%.
    const thisCycle = page.locator("dt", { hasText: /^This cycle$/ }).locator("xpath=following-sibling::dd[1]");
    await expect(thisCycle).toHaveText("—");

    // The pause control exists but is disabled while the scanner is stopped —
    // there is nothing to pause, and an enabled button would imply otherwise.
    // Held in memory, so a restart resets it — "never" would be a lie.
    const lastCompleted = page.locator("dt", { hasText: /^Last completed$/ }).locator("xpath=following-sibling::dd[1]");
    await expect(lastCompleted).toHaveText("no full pass since restart");

    const pauseButton = page.getByRole("button", { name: "Pause scanning" });
    await expect(pauseButton).toBeVisible();
    await expect(pauseButton).toBeDisabled();
    await expect(page.getByText("1 bookable · 0 no inventory · 0 first-come")).toBeVisible();
    await expect(page.getByText("Runs after each scan cycle")).toBeVisible();

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



/**
 * Pausing is the lever that separates "the app is broken" from "the app is
 * fine, the sweep isn't" — so it must be admin-only, like everything else that
 * changes what the server does.
 */
test.describe("scanner pause — authorization", () => {
  test.use({ user: null });

  test("refuses an anonymous caller", async ({ page }) => {
    const response = await page.request.post("/api/scanner-pause", { form: { paused: "true" } });
    expect(response.status()).toBe(401);
  });
});

test.describe("scanner pause — non-admin", () => {
  test.use({ user: { email: "nopause@example.com", firstName: "No", lastName: "Pause" } });

  test("refuses a signed-in user without the permission", async ({ page }) => {
    const response = await page.request.post("/api/scanner-pause", { form: { paused: "true" } });
    expect(response.status()).toBe(403);
  });
});

/**
 * Banning an account. It must actually bite — signing the account out and
 * stopping its email — and it must lift without losing anything.
 */
test.describe("ban users", () => {
  test.use({ user: { email: "admin@example.com", firstName: "Admin", lastName: "User", permissions: ["admin:site"] } });

  test("bans an account and lifts the ban", async ({ page }) => {
    const victim = await createOwnerUser({ email: "spammer@example.com", firstName: "Spam", lastName: "Mer" });

    await page.goto("/admin");
    const row = page.getByRole("row", { name: /spammer@example.com/ });
    await expect(row.getByRole("button", { name: "Ban", exact: true })).toBeVisible();
    await row.getByRole("button", { name: "Ban", exact: true }).click();

    await expect(page.getByRole("row", { name: /spammer@example.com/ }).getByText("Banned")).toBeVisible();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: victim.id } })).bannedAt).not.toBeNull();

    await page.getByRole("row", { name: /spammer@example.com/ }).getByRole("button", { name: "Unban" }).click();
    await expect(
      page.getByRole("row", { name: /spammer@example.com/ }).getByRole("button", { name: "Ban", exact: true }),
    ).toBeVisible();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: victim.id } })).bannedAt).toBeNull();
  });

  test("refuses to let an admin ban themselves", async ({ page }) => {
    const me = await prisma.user.findUniqueOrThrow({ where: { email: "admin@example.com" } });

    const response = await page.request.post("/api/user-ban", { form: { userId: me.id, banned: "true" } });

    expect(response.status()).toBe(422);
    expect((await response.json()).error).toContain("your own account");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: me.id } })).bannedAt).toBeNull();
  });
});

test.describe("ban users — authorization", () => {
  test.use({ user: { email: "nobody@example.com", firstName: "No", lastName: "Body" } });

  test("a non-admin cannot ban anyone", async ({ page }) => {
    const victim = await createOwnerUser({ email: "target@example.com", firstName: "Tar", lastName: "Get" });

    const response = await page.request.post("/api/user-ban", { form: { userId: victim.id, banned: "true" } });

    expect(response.status()).toBe(403);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: victim.id } })).bannedAt).toBeNull();
  });
});

/**
 * The users table has to answer "why didn't this person get an email?" without
 * a database session — so it shows what they watch, whether email is on, and
 * how much they have actually been sent.
 */
test.describe("user detail", () => {
  test.use({ user: { email: "admin@example.com", firstName: "Admin", lastName: "User", permissions: ["admin:site"] } });

  test("shows watches on demand, plus email state and volume", async ({ page }) => {
    const watcher = await createOwnerUser({ email: "watcher@example.com", firstName: "Wat", lastName: "Cher" });
    const park = await createPark({ name: "Big Basin Redwoods" });
    const facility = await createFacility({ name: "Huckleberry", parkId: park.id });
    await createWatch({ userId: watcher.id, facilityIds: facility.id, checkinDays: [5, 6], nights: 2 });

    await prisma.userPreference.create({
      data: { userId: watcher.id, emailNotifications: false, unsubscribeToken: `tok-${Date.now()}` },
    });
    await prisma.emailLog.create({ data: { quantity: 1, metadata: { [watcher.id]: ["evt-1"] } } });

    await page.goto("/admin");
    const row = page.getByRole("row", { name: /watcher@example.com/ });

    // Email is off, and we have sent them exactly one in both windows.
    await expect(row.getByText("off")).toBeVisible();
    await expect(row.getByText("1 / 1")).toBeVisible();

    // The watch itself is hidden until asked for.
    await expect(page.getByText("Big Basin Redwoods — Huckleberry")).toHaveCount(0);
    await row.getByRole("button", { name: "1" }).click();
    await expect(page.getByText("Big Basin Redwoods — Huckleberry")).toBeVisible();
    await expect(page.getByText("Fri, Sat · 2 nights")).toBeVisible();
  });

  test("says never for someone who has had no email", async ({ page }) => {
    await createOwnerUser({ email: "quiet@example.com", firstName: "Qui", lastName: "Et" });

    await page.goto("/admin");

    const row = page.getByRole("row", { name: /quiet@example.com/ });
    await expect(row.getByText("never")).toBeVisible();
    await expect(row.getByText("0 / 0")).toBeVisible();
  });
});

/**
 * What a banned person actually experiences.
 *
 * Auth0 has no idea we banned anyone, so signing in still succeeds on their
 * side. Without the callback check they would land back looking signed out,
 * try again, and loop — which is worse than a refusal.
 */
test.describe("being banned", () => {
  test.use({ user: { email: "banned@example.com", firstName: "Ban", lastName: "Ned" } });

  test("an existing session stops working the moment the ban lands", async ({ page }) => {
    // The session is live: a guarded page loads and the header greets them.
    await page.goto("/watches");
    await expect(page).toHaveURL(/\/watches/);
    await expect(page.getByRole("link", { name: "My watches" }).first()).toBeVisible();

    await prisma.user.update({ where: { email: "banned@example.com" }, data: { bannedAt: new Date() } });

    // Same cookie, now read as signed out. Checked on the home page because a
    // guarded route would bounce to Auth0, which tests cannot follow.
    await page.goto("/");
    await expect(page.getByRole("link", { name: "My watches" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Log in" }).first()).toBeVisible();
  });

  test("the account-closed page explains it and needs no session", async ({ page }) => {
    await page.goto("/account-closed");

    await expect(page.getByRole("heading", { name: "Account closed" })).toBeVisible();
    await expect(page.getByText("This account can no longer be used")).toBeVisible();
    await expect(page.getByText("Nothing has been deleted", { exact: false })).toBeVisible();
  });
});
