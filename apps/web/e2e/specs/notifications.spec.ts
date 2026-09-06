import { prisma } from "@campingmeow/database";
import { test, expect } from "../test-fixtures";
import { createOwnerUser, createPark, createFacility, createWatch, createSlots, nextWeekday, isoDate } from "../utilities/utilities";
import { notificationService } from "../../app/services/notification.service.server";
import { stubSender } from "../../app/lib/email.server";
import { DAILY_EMAIL_LIMIT, EMAIL_QUOTA_WINDOW_MS } from "../../app/lib/limits";

/**
 * The notifier turns "a night opened" into "you have mail". These drive
 * `runOnce()` directly — the notifier has no loop of its own, and the scanner
 * that would call it is off in tests (DISABLE_SCANNER=1), so nothing races
 * them. RESEND_API_KEY is kept out of the web server's env, so the sender is
 * always the stub.
 */
const UNIT_ID = 4242;
const SITE = "Site 42";

/** An opening the notifier will pick up: an `opened` event with no notifiedAt. */
async function openingEvent(facilityId: string, date: Date) {
  return prisma.availabilityEvent.create({
    data: { facilityId, unitId: UNIT_ID, unitName: SITE, date, type: "opened" },
  });
}

async function setup(opts: { checkinDays: number[]; nights: number }) {
  const user = await createOwnerUser({ email: `notify-${Date.now()}@example.com`, firstName: "Note", lastName: "Ify" });
  const park = await createPark({ name: "Big Basin Redwoods" });
  const facility = await createFacility({ name: "Huckleberry", parkId: park.id, lastScannedAt: new Date() });
  await createWatch({ userId: user.id, facilityIds: facility.id, checkinDays: opts.checkinDays, nights: opts.nights });
  return { user, park, facility };
}

test.describe("notifier", () => {
  test.use({ user: null });

  test.beforeEach(() => {
    stubSender.sent.length = 0;
  });

  test("emails the watcher when a matching night opens, and stamps the event", async () => {
    const fri = nextWeekday(5);
    const { user, facility } = await setup({ checkinDays: [5], nights: 1 });
    await createSlots({ facilityId: facility.id, unitId: UNIT_ID, unitName: SITE, dates: [fri] });
    const event = await openingEvent(facility.id, fri);

    const result = await notificationService.runOnce();

    expect(result).toEqual({ events: 1, emails: 1 });
    expect(stubSender.sent).toHaveLength(1);
    expect(stubSender.sent[0]!.to).toBe(user.email);
    expect(stubSender.sent[0]!.text).toContain("Huckleberry");
    expect(stubSender.sent[0]!.text).toContain(isoDate(fri));

    // Stamped, so the next pass ignores it — this is the no-repeat guarantee.
    const after = await prisma.availabilityEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(after.notifiedAt).not.toBeNull();

    stubSender.sent.length = 0;
    expect(await notificationService.runOnce()).toEqual({ events: 0, emails: 0 });
    expect(stubSender.sent).toHaveLength(0);

    const log = await prisma.emailLog.findFirstOrThrow();
    expect(log.quantity).toBe(1);
    expect(log.metadata).toEqual({ [user.id]: [event.id] });
  });

  test("a night opening completes a multi-night stay whose other nights were already free", async () => {
    // Watch wants Friday, 2 nights. Saturday was already free; Friday is what opens.
    const fri = nextWeekday(5);
    const sat = new Date(fri);
    sat.setUTCDate(sat.getUTCDate() + 1);

    const { facility } = await setup({ checkinDays: [5], nights: 2 });
    await createSlots({ facilityId: facility.id, unitId: UNIT_ID, unitName: SITE, dates: [fri, sat] });
    await openingEvent(facility.id, fri);

    expect((await notificationService.runOnce()).emails).toBe(1);
    expect(stubSender.sent[0]!.text).toContain("2 nights");
  });

  test("the opened night can be the SECOND night of the stay", async () => {
    // Friday was already free; Saturday opens. The Fri-Sat stay only exists now.
    const fri = nextWeekday(5);
    const sat = new Date(fri);
    sat.setUTCDate(sat.getUTCDate() + 1);

    const { facility } = await setup({ checkinDays: [5], nights: 2 });
    await createSlots({ facilityId: facility.id, unitId: UNIT_ID, unitName: SITE, dates: [fri, sat] });
    await openingEvent(facility.id, sat); // <- the Saturday night is what opened

    expect((await notificationService.runOnce()).emails).toBe(1);
    expect(stubSender.sent[0]!.text).toContain(isoDate(fri)); // reported as a Friday check-in
  });

  test("does not email when the stay is incomplete", async () => {
    // Friday opens but Saturday is still booked, so there is no 2-night stay.
    const fri = nextWeekday(5);
    const { facility } = await setup({ checkinDays: [5], nights: 2 });
    await createSlots({ facilityId: facility.id, unitId: UNIT_ID, unitName: SITE, dates: [fri] });
    await openingEvent(facility.id, fri);

    const result = await notificationService.runOnce();
    expect(result.emails).toBe(0);
    expect(stubSender.sent).toHaveLength(0);
    // Still marked handled, or the notifier re-examines it forever.
    expect(await prisma.availabilityEvent.count({ where: { notifiedAt: null } })).toBe(0);
  });

  test("does not email when the opening falls on an unwanted weekday", async () => {
    const tue = nextWeekday(2);
    const { facility } = await setup({ checkinDays: [5, 6], nights: 1 }); // Fri/Sat only
    await createSlots({ facilityId: facility.id, unitId: UNIT_ID, unitName: SITE, dates: [tue] });
    await openingEvent(facility.id, tue);

    expect((await notificationService.runOnce()).emails).toBe(0);
  });

  test("two nights of the same stay opening at once is still one line, not two", async () => {
    const fri = nextWeekday(5);
    const sat = new Date(fri);
    sat.setUTCDate(sat.getUTCDate() + 1);

    const { facility } = await setup({ checkinDays: [5], nights: 2 });
    await createSlots({ facilityId: facility.id, unitId: UNIT_ID, unitName: SITE, dates: [fri, sat] });
    await openingEvent(facility.id, fri);
    await openingEvent(facility.id, sat);

    const result = await notificationService.runOnce();
    expect(result.events).toBe(2);
    expect(result.emails).toBe(1);
    // One stay, so the check-in date appears once in the body.
    expect(stubSender.sent[0]!.text.split(isoDate(fri)).length - 1).toBe(1);
  });

  test("openings nobody watches are marked handled and email nobody", async () => {
    const park = await createPark({ name: "Unwatched Park" });
    const facility = await createFacility({ name: "Nobody Cares Camp", parkId: park.id });
    const fri = nextWeekday(5);
    await createSlots({ facilityId: facility.id, unitId: UNIT_ID, unitName: SITE, dates: [fri] });
    await openingEvent(facility.id, fri);

    expect(await notificationService.runOnce()).toEqual({ events: 1, emails: 0 });
    expect(stubSender.sent).toHaveLength(0);
    expect(await prisma.availabilityEvent.count({ where: { notifiedAt: null } })).toBe(0);
    expect(await prisma.emailLog.count()).toBe(0);
  });

  test("a closed event never triggers mail", async () => {
    const fri = nextWeekday(5);
    const { facility } = await setup({ checkinDays: [5], nights: 1 });
    await createSlots({ facilityId: facility.id, unitId: UNIT_ID, unitName: SITE, dates: [fri] });
    await prisma.availabilityEvent.create({
      data: { facilityId: facility.id, unitId: UNIT_ID, unitName: SITE, date: fri, type: "closed" },
    });

    expect(await notificationService.runOnce()).toEqual({ events: 0, emails: 0 });
  });
});

/**
 * The free Resend tier is 100 emails a day, and their quota "resets after 24
 * hours" rather than at midnight — so we count over a trailing window. Running
 * out must pause sending without losing the openings.
 */
test.describe("daily email cap", () => {
  test.use({ user: null });

  test.beforeEach(() => {
    stubSender.sent.length = 0;
  });

  /** Pretend we already sent `quantity` emails `hoursAgo` hours ago. */
  async function seedSends(quantity: number, hoursAgo: number) {
    return prisma.emailLog.create({
      data: { quantity, metadata: {}, sentAt: new Date(Date.now() - hoursAgo * 60 * 60 * 1000) },
    });
  }

  test("holds openings unsent once the allowance is gone, and retries them later", async () => {
    const fri = nextWeekday(5);
    const { facility } = await setup({ checkinDays: [5], nights: 1 });
    await createSlots({ facilityId: facility.id, unitId: UNIT_ID, unitName: SITE, dates: [fri] });
    const event = await openingEvent(facility.id, fri);

    const spent = await seedSends(DAILY_EMAIL_LIMIT, 1);

    const result = await notificationService.runOnce();
    expect(result.emails).toBe(0);
    expect(stubSender.sent).toHaveLength(0);

    // The outbox property: held, not dropped. Marking it notified here would
    // lose the opening forever.
    const held = await prisma.availabilityEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(held.notifiedAt).toBeNull();

    // Age those sends out of the trailing window; the same event now goes out.
    await prisma.emailLog.update({
      where: { id: spent.id },
      data: { sentAt: new Date(Date.now() - EMAIL_QUOTA_WINDOW_MS - 60_000) },
    });

    expect((await notificationService.runOnce()).emails).toBe(1);
    expect(stubSender.sent).toHaveLength(1);
    const after = await prisma.availabilityEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(after.notifiedAt).not.toBeNull();
  });

  test("counts over a rolling 24 hours, not since midnight", async () => {
    await seedSends(DAILY_EMAIL_LIMIT, 25);
    const stale = await notificationService.getQuotaStatus();
    expect(stale.sentLast24h).toBe(0);
    expect(stale.paused).toBe(false);

    await seedSends(DAILY_EMAIL_LIMIT, 2);
    const spent = await notificationService.getQuotaStatus();
    expect(spent.sentLast24h).toBe(DAILY_EMAIL_LIMIT);
    expect(spent.remaining).toBe(0);
    expect(spent.paused).toBe(true);
    // Budget returns when the oldest batch in the window ages out of it.
    expect(Date.parse(spent.resumesAt!)).toBeGreaterThan(Date.now());
  });

  test("tells people on the home page when alerts are paused", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Email alerts are paused")).toBeHidden();

    await seedSends(DAILY_EMAIL_LIMIT, 1);

    await page.goto("/");
    await expect(page.getByText("Email alerts are paused")).toBeVisible();
    await expect(page.getByText("Openings are still being tracked and held", { exact: false })).toBeVisible();
  });
});
