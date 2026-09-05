import { prisma } from "@campingmeow/database";
import { test, expect } from "../test-fixtures";
import { createOwnerUser, createPark, createFacility, createWatch, createSlots, nextWeekday } from "../utilities/utilities";
import { notificationService } from "../../app/services/notification.service.server";
import { preferenceService } from "../../app/services/preference.service.server";
import { stubSender } from "../../app/lib/email.server";

/**
 * Email is a delivery channel, not the subscription: turning it off leaves the
 * watch running so the openings are still there to look at in-app.
 *
 * The unsubscribe token is a bearer credential — whoever holds the email holds
 * it — so these also pin down that it can do exactly one thing.
 */
test.describe("preferences — signed in", () => {
  test.use({ user: { email: "prefs@example.com", firstName: "Pref", lastName: "User" } });

  test("email is on by default, and can be turned off and back on", async ({ page }) => {
    await page.goto("/preferences");

    await expect(page.getByText("Email notifications", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Turn off email notifications" }).click();
    await expect(page.getByText("We've stopped emailing you.")).toBeVisible();

    // Reload rather than trusting the action's reply — proves it persisted.
    await page.reload();
    await expect(page.getByRole("button", { name: "Turn email notifications back on" })).toBeVisible();

    await page.getByRole("button", { name: "Turn email notifications back on" }).click();
    await expect(page.getByText("We'll email you when a site opens.")).toBeVisible();
  });
});

test.describe("preferences — by token, logged out", () => {
  test.use({ user: null });

  test("404s with neither token nor session", async ({ page }) => {
    const response = await page.goto("/preferences");
    expect(response?.status()).toBe(404);
  });

  test("rejects an unknown token", async ({ page }) => {
    await page.goto("/preferences?token=not-a-real-token");
    await expect(page.getByText("That link is no longer valid.")).toBeVisible();
  });

  test("a valid token toggles email and grants nothing else", async ({ page }) => {
    const user = await createOwnerUser({ email: "tokened@example.com", firstName: "Tok", lastName: "En" });
    const park = await createPark({ name: "Secret Park" });
    const facility = await createFacility({ name: "Secret Camp", parkId: park.id });
    await createWatch({ userId: user.id, facilityIds: facility.id });
    const token = await preferenceService.getUnsubscribeToken(user.id);

    await page.goto(`/preferences?token=${token}`);

    // May show the address the email already went to — and nothing more.
    await expect(page.getByText("tokened@example.com")).toBeVisible();
    await expect(page.getByText("Secret Camp")).toHaveCount(0);
    await expect(page.getByText("Secret Park")).toHaveCount(0);
    // It is not a login.
    await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();

    await page.getByRole("button", { name: "Turn off email notifications" }).click();
    await expect(page.getByText("We've stopped emailing you.")).toBeVisible();

    const pref = await prisma.userPreference.findUniqueOrThrow({ where: { userId: user.id } });
    expect(pref.emailNotifications).toBe(false);
    // The watch is untouched — email is the channel, not the subscription.
    expect(await prisma.watch.count({ where: { userId: user.id, active: true } })).toBe(1);
  });

  test("merely loading the page never changes anything", async ({ page }) => {
    // Corporate mail scanners follow every link in an email before a human does.
    const user = await createOwnerUser({ email: "scanner@example.com", firstName: "Scan", lastName: "Ner" });
    const token = await preferenceService.getUnsubscribeToken(user.id);

    await page.goto(`/preferences?token=${token}`);
    await page.goto(`/preferences?token=${token}`);

    const pref = await prisma.userPreference.findUniqueOrThrow({ where: { userId: user.id } });
    expect(pref.emailNotifications).toBe(true);
  });

  test("Gmail one-click posts the token in the URL with no form body", async ({ page }) => {
    const user = await createOwnerUser({ email: "oneclick@example.com", firstName: "One", lastName: "Click" });
    const token = await preferenceService.getUnsubscribeToken(user.id);

    // Exactly what RFC 8058 sends: token in the query string, this in the body.
    const response = await page.request.post(`/preferences?token=${token}`, {
      form: { "List-Unsubscribe": "One-Click" },
    });
    expect(response.status()).toBe(200);

    const pref = await prisma.userPreference.findUniqueOrThrow({ where: { userId: user.id } });
    expect(pref.emailNotifications).toBe(false);
  });
});

test.describe("notifier respects the preference", () => {
  test.use({ user: null });

  test.beforeEach(() => {
    stubSender.sent.length = 0;
  });

  async function seedOpening(email: string, unitId: number) {
    const user = await createOwnerUser({ email, firstName: "Seed", lastName: "User" });
    const park = await createPark({ name: `Park ${unitId}` });
    const facility = await createFacility({ name: `Camp ${unitId}`, parkId: park.id, lastScannedAt: new Date() });
    await createWatch({ userId: user.id, facilityIds: facility.id, checkinDays: [5], nights: 1 });

    const fri = nextWeekday(5);
    await createSlots({ facilityId: facility.id, unitId, unitName: `Site ${unitId}`, dates: [fri] });
    await prisma.availabilityEvent.create({
      data: { facilityId: facility.id, unitId, unitName: `Site ${unitId}`, date: fri, type: "opened" },
    });
    return user;
  }

  test("skips users with email off, and leaves their watch running", async () => {
    const user = await seedOpening("quiet@example.com", 77);
    await preferenceService.setEmailNotificationsForUser(user.id, false);

    expect((await notificationService.runOnce()).emails).toBe(0);
    expect(stubSender.sent).toHaveLength(0);
    // Watch stays active: the scanner keeps working so openings are there in-app.
    expect(await prisma.watch.count({ where: { userId: user.id, active: true } })).toBe(1);
  });

  test("the email carries the unsubscribe link and one-click headers", async () => {
    const user = await seedOpening("loud@example.com", 88);

    expect((await notificationService.runOnce()).emails).toBe(1);

    const sent = stubSender.sent[0]!;
    const token = await preferenceService.getUnsubscribeToken(user.id);
    expect(sent.text).toContain(`/preferences?token=${encodeURIComponent(token)}`);
    expect(sent.headers?.["List-Unsubscribe"]).toContain(token);
    expect(sent.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });
});
