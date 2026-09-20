import { prisma } from "@campingmeow/database";
import { test, expect } from "../test-fixtures";
import { createPark, createFacility, isoDate } from "../utilities/utilities";
import { startFakeRc, FAKE_UNIT_ID, FAKE_UNIT_NAME, type FakeRc } from "../utilities/fake-rc";
import { availabilityService } from "../../app/services/availability.service.server";

/**
 * ReserveCalifornia omits nights a site is not offered for — a dorm block
 * closed for the season, say — and a broken server in their fleet fills those
 * gaps in and marks them free. Measured 2026-09-19: one dorm returned 2 nights
 * in a healthy response and 21 in a bad one. That produced ~100 phantom
 * openings at a time and four "36 campsites just opened" emails a day to a real
 * user. See packages/scanner/API.md §4c.
 *
 * Absence is the tell: a night going **absent -> free** is invention, while
 * **reported-and-taken -> free** is a genuine cancellation.
 */

let fake: FakeRc;

test.beforeAll(async () => {
  fake = await startFakeRc();
});

test.afterAll(async () => {
  await fake.close();
});

/** A night inside the scanned window. */
function night(offset: number): string {
  return isoDate(new Date(Date.now() + offset * 24 * 60 * 60 * 1000));
}

const TARGET = 10;

/** A campground whose stored row for `night(TARGET)` is in a known state. */
async function facilityWith(name: string, stored: { isFree: boolean; reported: boolean } | null) {
  const park = await createPark({ name: `${name} Park` });
  // The fake ignores the RC id, so let the helper assign a unique one — two
  // facilities in one test would otherwise collide.
  const facility = await createFacility({ name, parkId: park.id });
  if (stored) {
    await prisma.availabilitySlot.create({
      data: {
        facilityId: facility.id,
        unitId: FAKE_UNIT_ID,
        unitName: FAKE_UNIT_NAME,
        date: new Date(`${night(TARGET)}T00:00:00Z`),
        isFree: stored.isFree,
        reported: stored.reported,
      },
    });
  }
  return facility;
}

function storedNight(facilityId: string) {
  return prisma.availabilitySlot.findFirstOrThrow({
    where: { facilityId, unitId: FAKE_UNIT_ID, date: new Date(`${night(TARGET)}T00:00:00Z`) },
  });
}

test.describe("invented availability is ignored", () => {
  test.use({ user: null });

  test("a night RC never reported cannot become an opening", async () => {
    // Stored as absent: RC has never spoken about this night.
    const facility = await facilityWith("Phantom Camp", { isFree: false, reported: false });
    fake.setReads([{ reported: [night(TARGET)], free: [night(TARGET)] }]);

    const summary = await availabilityService.scanFacility(facility.id);

    expect(summary.fabricated).toBe(1);
    expect(summary.opened).toBe(0);

    const events = await prisma.availabilityEvent.findMany({ where: { facilityId: facility.id } });
    expect(events).toHaveLength(0);

    // The stored row is carried forward untouched. Recording it as taken would
    // launder the lie into a legitimate baseline.
    const slot = await storedNight(facility.id);
    expect(slot.isFree).toBe(false);
    expect(slot.reported).toBe(false);
  });

  test("repeated invention never accumulates into a false opening", async () => {
    const facility = await facilityWith("Repeat Camp", { isFree: false, reported: false });
    fake.setReads([{ reported: [night(TARGET)], free: [night(TARGET)] }]);

    // Three bad responses in a row. If the first were recorded as taken, the
    // second would read as a cancellation and send the email.
    for (let i = 0; i < 3; i++) {
      const summary = await availabilityService.scanFacility(facility.id);
      expect(summary.fabricated).toBe(1);
      expect(summary.opened).toBe(0);
    }

    expect(await prisma.availabilityEvent.count({ where: { facilityId: facility.id } })).toBe(0);
  });

  test("a real cancellation still opens", async () => {
    // RC reported this night as taken; now it is free. That is a cancellation.
    const facility = await facilityWith("Real Camp", { isFree: false, reported: true });
    fake.setReads([{ reported: [night(TARGET)], free: [night(TARGET)] }]);

    const summary = await availabilityService.scanFacility(facility.id);

    expect(summary.fabricated).toBe(0);
    expect(summary.opened).toBe(1);

    const events = await prisma.availabilityEvent.findMany({ where: { facilityId: facility.id } });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("opened");
    expect((await storedNight(facility.id)).isFree).toBe(true);
  });

  /**
   * The baseline a cancellation is measured against. Without `reported` in the
   * diff, this row is "unchanged" (taken before, taken now) and never written —
   * so nothing would ever qualify as a real opening.
   */
  test("an absent night becoming taken establishes the baseline", async () => {
    const facility = await facilityWith("Baseline Camp", { isFree: false, reported: false });
    fake.setReads([{ reported: [night(TARGET)], free: [] }]);

    const summary = await availabilityService.scanFacility(facility.id);
    expect(summary.fabricated).toBe(0);
    expect(summary.opened).toBe(0);

    const slot = await storedNight(facility.id);
    expect(slot.reported).toBe(true);
    expect(slot.isFree).toBe(false);

    // And now a cancellation on that night is believed.
    fake.setReads([{ reported: [night(TARGET)], free: [night(TARGET)] }]);
    expect((await availabilityService.scanFacility(facility.id)).opened).toBe(1);
  });

  test("a night RC stops reporting is recorded as unavailable", async () => {
    const facility = await facilityWith("Closing Camp", { isFree: true, reported: true });
    fake.setReads([{ reported: [], free: [] }]);

    const summary = await availabilityService.scanFacility(facility.id);

    expect(summary.closed).toBe(1);
    expect(summary.fabricated).toBe(0);
    const slot = await storedNight(facility.id);
    expect(slot.isFree).toBe(false);
    expect(slot.reported).toBe(false);
  });

  /** A brand-new night is discovery, not invention — and still never emails. */
  test("a night with no stored row at all is not treated as invention", async () => {
    const facility = await facilityWith("Fresh Camp", null);
    fake.setReads([{ reported: [night(TARGET)], free: [night(TARGET)] }]);

    const summary = await availabilityService.scanFacility(facility.id);

    expect(summary.fabricated).toBe(0);
    expect(summary.opened).toBe(0);
    const slot = await storedNight(facility.id);
    expect(slot.isFree).toBe(true);
    expect(slot.reported).toBe(true);
  });

  /**
   * The check is deterministic, so finding invented availability costs no extra
   * requests — unlike the second read this replaced.
   */
  test("detecting invention costs no extra requests", async () => {
    const clean = await facilityWith("Clean Camp", { isFree: false, reported: true });
    fake.setReads([{ reported: [night(TARGET)], free: [] }]);
    const beforeClean = fake.requests;
    const cleanSummary = await availabilityService.scanFacility(clean.id);
    const cleanRequests = fake.requests - beforeClean;
    expect(cleanSummary.fabricated).toBe(0);

    const phantom = await facilityWith("Phantom Cost Camp", { isFree: false, reported: false });
    fake.setReads([{ reported: [night(TARGET)], free: [night(TARGET)] }]);
    const beforePhantom = fake.requests;
    const phantomSummary = await availabilityService.scanFacility(phantom.id);
    const phantomRequests = fake.requests - beforePhantom;
    expect(phantomSummary.fabricated).toBe(1);

    expect(phantomRequests).toBe(cleanRequests);
  });
});
