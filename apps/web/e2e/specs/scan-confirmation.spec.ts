import { prisma } from "@campingmeow/database";
import { test, expect } from "../test-fixtures";
import { createPark, createFacility, isoDate } from "../utilities/utilities";
import { startFakeRc, FAKE_UNIT_ID, FAKE_UNIT_NAME, type FakeRc } from "../utilities/fake-rc";
import { availabilityService } from "../../app/services/availability.service.server";

/**
 * ReserveCalifornia's grid is not deterministic. Measured 2026-09-19, roughly
 * one response in eight reported a whole block of booked sites as free — same
 * facility, same dates, same request, seconds apart. It fabricates
 * availability, never reservations.
 *
 * Unchecked that becomes email about sites nobody can book: one bad response
 * at Crystal Cove produced ~100 phantom openings and four "36 campsites just
 * opened" messages a day to a real person. So an opening is only believed when
 * a second read agrees. See packages/scanner/API.md §4c.
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

async function facilityWithStoredNight(name: string, isFree: boolean) {
  const park = await createPark({ name: `${name} Park` });
  const facility = await createFacility({ name, parkId: park.id, rcFacilityId: 757 });
  // The "before" picture the scan diffs against.
  await prisma.availabilitySlot.create({
    data: {
      facilityId: facility.id,
      unitId: FAKE_UNIT_ID,
      unitName: FAKE_UNIT_NAME,
      date: new Date(`${night(10)}T00:00:00Z`),
      isFree,
    },
  });
  return facility;
}

test.describe("openings are confirmed by a second read", () => {
  test.use({ user: null });

  test("rejects an opening the second read contradicts, and records no event", async () => {
    const facility = await facilityWithStoredNight("Phantom Camp", false);
    // First read claims it opened; the confirming read says it never did.
    fake.setReads([[night(10)], []]);

    const summary = await availabilityService.scanFacility(facility.id);

    expect(summary.rejected).toBe(1);
    expect(summary.opened).toBe(0);
    expect(summary.freeSlots).toBe(0);

    // Nothing to email about, and the stored night stays booked.
    const events = await prisma.availabilityEvent.findMany({ where: { facilityId: facility.id } });
    expect(events).toHaveLength(0);
    // Scoped to the night in question: the scan writes a row for all 64 nights
    // in the window, and findFirst would return an arbitrary one.
    const slot = await prisma.availabilitySlot.findFirstOrThrow({
      where: { facilityId: facility.id, unitId: FAKE_UNIT_ID, date: new Date(`${night(10)}T00:00:00Z`) },
    });
    expect(slot.isFree).toBe(false);
  });

  test("keeps an opening both reads agree on", async () => {
    const facility = await facilityWithStoredNight("Real Camp", false);
    fake.setReads([[night(10)], [night(10)]]);

    const summary = await availabilityService.scanFacility(facility.id);

    expect(summary.rejected).toBe(0);
    expect(summary.opened).toBe(1);

    const events = await prisma.availabilityEvent.findMany({ where: { facilityId: facility.id } });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("opened");
    // Scoped to the night in question: the scan writes a row for all 64 nights
    // in the window, and findFirst would return an arbitrary one.
    const slot = await prisma.availabilitySlot.findFirstOrThrow({
      where: { facilityId: facility.id, unitId: FAKE_UNIT_ID, date: new Date(`${night(10)}T00:00:00Z`) },
    });
    expect(slot.isFree).toBe(true);
  });

  /**
   * The check costs three extra requests, so it must not run on the common
   * path — the overwhelming majority of scans find nothing new.
   */
  test("does not read twice when nothing opened", async () => {
    const facility = await facilityWithStoredNight("Quiet Camp", false);
    fake.setReads([[], []]);

    const before = fake.requests;
    const summary = await availabilityService.scanFacility(facility.id);
    const used = fake.requests - before;

    expect(summary.opened).toBe(0);
    expect(summary.rejected).toBe(0);
    // One read's worth of pages, not two.
    expect(used).toBeLessThanOrEqual(4);
  });

  /**
   * A night going the other way needs no second opinion: the API invents
   * availability, not reservations, so a disappearance is trustworthy.
   */
  test("does not second-guess a night that closed", async () => {
    const facility = await facilityWithStoredNight("Closing Camp", true);
    fake.setReads([[], []]);

    const before = fake.requests;
    const summary = await availabilityService.scanFacility(facility.id);

    expect(summary.closed).toBe(1);
    expect(summary.rejected).toBe(0);
    expect(fake.requests - before).toBeLessThanOrEqual(4);
  });
});
