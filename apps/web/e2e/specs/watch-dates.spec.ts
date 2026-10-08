import { prisma } from "@campingmeow/database";
import { test, expect } from "../test-fixtures";
import {
  createFacility,
  createOwnerUser,
  createPark,
  createSlots,
  createWatch,
  isoDate,
  nextWeekday,
} from "../utilities/utilities";
import { stubSender } from "../../app/lib/email.server";
import { HORIZON_DAYS, MAX_WATCHES_PER_USER } from "../../app/lib/limits";
import { checkinLabel } from "../../app/lib/watch-schedule";
import { notificationService } from "../../app/services/notification.service.server";

/**
 * Watches on specific check-in dates ("free weekends 2 and 5"), as opposed to a
 * weekly pattern. A dated watch expires once every check-in has passed, stays
 * listed, and can be edited back to life with new dates.
 */

function plusDays(date: Date, n: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + n);
  return next;
}

function daysAgo(n: number): Date {
  const now = new Date();
  return plusDays(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())), -n);
}

/** Click a day in the picker, paging forward a month if it isn't on screen. */
async function pickDate(page: import("@playwright/test").Page, date: Date) {
  const cell = page.locator(`td[data-day="${isoDate(date)}"]:not([data-outside]) button`);
  if ((await cell.count()) === 0) {
    await page.getByRole("button", { name: /next month/i }).click();
  }
  await cell.click();
}

test.describe("dated watches", () => {
  test.use({ user: { email: "dated@example.com", firstName: "Dee", lastName: "Ated" } });

  test("creates a watch on two specific check-ins and lists them", async ({ page }) => {
    const park = await createPark({ name: "Big Sur" });
    const facility = await createFacility({ name: "Pfeiffer", parkId: park.id });
    const weekend2 = nextWeekday(5, 7);
    const weekend5 = plusDays(weekend2, 21);

    await page.goto(`/watches/new?facilityId=${facility.id}`);
    await page.getByLabel("Specific check-in dates").click();
    await pickDate(page, weekend2);
    await pickDate(page, weekend5);
    await page.getByLabel("Nights").fill("2");
    await page.getByRole("button", { name: "Create watch" }).click();

    await expect(page).toHaveURL(/\/watches$/);
    await expect(
      page.getByText(`Check-in ${checkinLabel(isoDate(weekend2))}, ${checkinLabel(isoDate(weekend5))} · 2 nights`),
    ).toBeVisible();

    const watch = await prisma.watch.findFirstOrThrow({ where: { user: { email: "dated@example.com" } } });
    expect(watch.checkinDays).toEqual([]);
    expect(watch.checkinDates.map(isoDate)).toEqual([isoDate(weekend2), isoDate(weekend5)]);
  });

  test("needs at least one date", async ({ page }) => {
    const park = await createPark({ name: "Montaña de Oro" });
    const facility = await createFacility({ name: "Islay Creek", parkId: park.id });

    await page.goto(`/watches/new?facilityId=${facility.id}`);
    await page.getByLabel("Specific check-in dates").click();
    await page.getByRole("button", { name: "Create watch" }).click();

    await expect(page.getByText("Pick at least one check-in date.")).toBeVisible();
  });

  test("refuses a stay that runs past the scanned window, even if the form is bypassed", async ({ page }) => {
    const park = await createPark({ name: "Mount Tam" });
    const facility = await createFacility({ name: "Pantoll", parkId: park.id });

    // The last scanned night is today + HORIZON_DAYS. A 1-night stay can check
    // in then; a 2-night stay can't, because its second night is out of range.
    const lastNight = isoDate(daysAgo(-HORIZON_DAYS));
    const post = (nights: number) =>
      page.request.post("/watches/new", {
        form: { facilityIds: facility.id, mode: "dates", checkinDates: lastNight, nights: String(nights) },
        maxRedirects: 0,
      });

    const tooLong = await post(2);
    expect(tooLong.status()).toBe(200);
    expect(await prisma.watch.count()).toBe(0);

    const fits = await post(1);
    expect(fits.status()).toBe(302);
    expect(await prisma.watch.count()).toBe(1);
  });

  test("refuses a check-in in the past", async ({ page }) => {
    const park = await createPark({ name: "Henry Cowell" });
    const facility = await createFacility({ name: "Graham Hill", parkId: park.id });

    const response = await page.request.post("/watches/new", {
      form: { facilityIds: facility.id, mode: "dates", checkinDates: isoDate(daysAgo(1)), nights: "1" },
      maxRedirects: 0,
    });

    expect(response.status()).toBe(200);
    expect(await prisma.watch.count()).toBe(0);
  });

  test("expires once every check-in has passed, stays listed, and comes back when edited", async ({ page }) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email: "dated@example.com" } });
    const park = await createPark({ name: "Samuel P. Taylor" });
    const facility = await createFacility({ name: "Redwood Grove", parkId: park.id });
    await createWatch({
      userId: user.id,
      facilityIds: facility.id,
      checkinDays: [],
      checkinDates: [daysAgo(10), daysAgo(3)],
      nights: 2,
    });

    await page.goto("/watches");
    const list = page.locator("[data-slot='list']");
    await expect(list.getByText("Expired", { exact: true })).toBeVisible();
    await expect(list.getByText("every check-in date has passed")).toBeVisible();

    await list.getByRole("link", { name: "Edit" }).click();
    await expect(page.getByRole("heading", { name: "Edit watch" })).toBeVisible();
    await expect(page.getByText("Pick new ones to start it again")).toBeVisible();
    // Its campground and stay length carry over, so only the dates need picking.
    await expect(page.getByLabel("Samuel P. Taylor · Redwood Grove")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByLabel("Nights")).toHaveValue("2");
    await expect(page.getByLabel("Specific check-in dates")).toHaveAttribute("aria-checked", "true");

    const next = nextWeekday(6);
    await pickDate(page, next);
    await page.getByRole("button", { name: "Save changes" }).click();

    await expect(page).toHaveURL(/\/watches$/);
    await expect(list.getByText("Expired", { exact: true })).toHaveCount(0);
    await expect(list.getByText(`Check-in ${checkinLabel(isoDate(next))} · 2 nights`)).toBeVisible();
    // Edited in place — still one watch.
    expect(await prisma.watch.count({ where: { userId: user.id } })).toBe(1);
  });

  test("a watch with one date passed and one ahead is still live, and lists only the one ahead", async ({ page }) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email: "dated@example.com" } });
    const park = await createPark({ name: "Portola Redwoods" });
    const facility = await createFacility({ name: "Main", parkId: park.id });
    const ahead = nextWeekday(5);
    await createWatch({
      userId: user.id,
      facilityIds: facility.id,
      checkinDays: [],
      checkinDates: [daysAgo(5), ahead],
    });

    await page.goto("/watches");
    const list = page.locator("[data-slot='list']");
    await expect(list.getByText(`Check-in ${checkinLabel(isoDate(ahead))} · 1 night`, { exact: true })).toBeVisible();
    await expect(list.getByText("Expired", { exact: true })).toHaveCount(0);
  });

  test("an expired watch does not count against the per-user limit", async ({ page }) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email: "dated@example.com" } });
    const park = await createPark({ name: "Castle Rock" });
    const facility = await createFacility({ name: "Trail Camp", parkId: park.id });
    for (let i = 0; i < MAX_WATCHES_PER_USER - 1; i++) {
      await createWatch({ userId: user.id, facilityIds: facility.id });
    }
    await createWatch({ userId: user.id, facilityIds: facility.id, checkinDays: [], checkinDates: [daysAgo(2)] });

    // Nine live and one expired: there is room for a tenth.
    await page.goto(`/watches/new?facilityId=${facility.id}`);
    await page.getByRole("button", { name: "Create watch" }).click();
    await expect(page).toHaveURL(/\/watches$/);

    // Now ten live: the next is refused.
    await page.goto(`/watches/new?facilityId=${facility.id}`);
    await page.getByRole("button", { name: "Create watch" }).click();
    await expect(page.getByText(`You already have ${MAX_WATCHES_PER_USER} watches`, { exact: false })).toBeVisible();
  });

  test("editing a watch at the limit is not refused for being one too many", async ({ page }) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email: "dated@example.com" } });
    const park = await createPark({ name: "Butano" });
    const facility = await createFacility({ name: "Ben Ries", parkId: park.id });
    for (let i = 0; i < MAX_WATCHES_PER_USER; i++) {
      await createWatch({ userId: user.id, facilityIds: facility.id });
    }
    const watch = await prisma.watch.findFirstOrThrow({ where: { userId: user.id } });

    await page.goto(`/watches/${watch.id}/edit`);
    await page.getByLabel("Nights").fill("3");
    await page.getByRole("button", { name: "Save changes" }).click();

    await expect(page).toHaveURL(/\/watches$/);
    expect((await prisma.watch.findUniqueOrThrow({ where: { id: watch.id } })).nights).toBe(3);
  });

  test("switching a pattern watch to dates clears its weekdays", async ({ page }) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email: "dated@example.com" } });
    const park = await createPark({ name: "Half Moon Bay" });
    const facility = await createFacility({ name: "Francis Beach", parkId: park.id });
    const watch = await createWatch({ userId: user.id, facilityIds: facility.id, checkinDays: [5, 6] });
    const date = nextWeekday(4);

    await page.goto(`/watches/${watch.id}/edit`);
    await page.getByLabel("Specific check-in dates").click();
    await pickDate(page, date);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page).toHaveURL(/\/watches$/);

    const after = await prisma.watch.findUniqueOrThrow({ where: { id: watch.id } });
    expect(after.checkinDays).toEqual([]);
    expect(after.checkinDates.map(isoDate)).toEqual([isoDate(date)]);
  });

  test("the watches calendar marks only the chosen check-ins", async ({ page }) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email: "dated@example.com" } });
    const park = await createPark({ name: "Point Lobos" });
    const facility = await createFacility({ name: "Carmel", parkId: park.id, lastScannedAt: new Date() });
    // Two free Fridays a week apart, in the same month view where possible. Only
    // the one the watch names should be marked.
    const wanted = nextWeekday(5);
    const other = plusDays(wanted, 7);
    await createSlots({ facilityId: facility.id, unitId: 1, unitName: "Site 1", dates: [wanted, other] });
    await createWatch({ userId: user.id, facilityIds: facility.id, checkinDays: [], checkinDates: [wanted] });

    await page.goto("/watches");
    await expect(page.getByText("A stay matching your watch can start here")).toBeVisible();

    const marked = await page
      .locator('td[class*="bg-primary"]')
      .evaluateAll((cells) => cells.map((cell) => cell.getAttribute("data-day")));
    expect(marked).toEqual([isoDate(wanted)]);
  });
});

test.describe("dated watches — cross-user authorization", () => {
  test.use({ user: { email: "snoop@example.com", firstName: "Sn", lastName: "Oop" } });

  test("someone else's watch 404s on the edit page, and can't be changed by posting", async ({ page }) => {
    const owner = await createOwnerUser({ email: "dated-owner@example.com", firstName: "Own", lastName: "Er" });
    const park = await createPark({ name: "Salt Point" });
    const facility = await createFacility({ name: "Gerstle Cove", parkId: park.id });
    const theirs = await createWatch({ userId: owner.id, facilityIds: facility.id, nights: 1 });

    const view = await page.goto(`/watches/${theirs.id}/edit`);
    expect(view?.status()).toBe(404);

    const post = await page.request.post(`/watches/${theirs.id}/edit`, {
      form: { facilityIds: facility.id, mode: "pattern", checkinDays: "5", nights: "4" },
      maxRedirects: 0,
    });
    expect(post.status()).toBe(404);
    expect((await prisma.watch.findUniqueOrThrow({ where: { id: theirs.id } })).nights).toBe(1);
  });
});

test.describe("dated watches — notifier", () => {
  test.use({ user: null });

  test.beforeEach(() => {
    stubSender.sent.length = 0;
  });

  test("emails about the chosen check-in and not about other Fridays", async () => {
    const user = await createOwnerUser({ email: `dated-notify-${Date.now()}@example.com`, firstName: "N", lastName: "O" });
    const park = await createPark({ name: "Russian Gulch" });
    const facility = await createFacility({ name: "Main Camp", parkId: park.id, lastScannedAt: new Date() });
    const wanted = nextWeekday(5);
    const other = plusDays(wanted, 7);
    await createWatch({ userId: user.id, facilityIds: facility.id, checkinDays: [], checkinDates: [wanted] });
    await createSlots({ facilityId: facility.id, unitId: 77, unitName: "Site 77", dates: [wanted, other] });
    for (const date of [wanted, other]) {
      await prisma.availabilityEvent.create({
        data: { facilityId: facility.id, unitId: 77, unitName: "Site 77", date, type: "opened" },
      });
    }

    const result = await notificationService.runOnce();

    expect(result.emails).toBe(1);
    expect(stubSender.sent[0]!.text).toContain(isoDate(wanted));
    expect(stubSender.sent[0]!.text).not.toContain(isoDate(other));
  });
});
