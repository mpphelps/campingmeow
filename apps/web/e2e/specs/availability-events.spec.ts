import { prisma } from "@campingmeow/database";
import { test, expect } from "../test-fixtures";
import { createPark, createFacility, createSlots } from "../utilities/utilities";
import { availabilityRepository } from "../../app/repositories/availability.repository.server";

/**
 * AvailabilitySlot holds current state and is overwritten every scan, so the moment a
 * night flips is only observable during that scan. AvailabilityEvent is the append-only
 * record of those flips, and the only thing that can answer "did something just open?".
 *
 * These drive the repository directly rather than through a scan, because a real scan
 * would call ReserveCalifornia. The diff itself is what's under test.
 */
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const START = d("2026-09-01");
const END = d("2026-09-03");
const NIGHTS = ["2026-09-01", "2026-09-02", "2026-09-03"];

/** Mirrors runScan: read the window, diff it, write slots + events atomically. */
async function scan(facilityId: string, freeByDate: Record<string, boolean>) {
  const slots = Object.entries(freeByDate).map(([date, isFree]) => ({
    unitId: 1,
    unitName: "Site 1",
    date: d(date),
    isFree,
  }));
  const previous = await availabilityRepository.listWindow(facilityId, START, END);
  const before = new Map(previous.map((p) => [`${p.unitId}:${p.date.toISOString().slice(0, 10)}`, p.isFree]));

  const events = slots.flatMap((slot) => {
    const was = before.get(`${slot.unitId}:${slot.date.toISOString().slice(0, 10)}`);
    // No previous row means discovery, not a transition — see the service's diffEvents.
    if (was === undefined || was === slot.isFree) return [];
    return [{ unitId: slot.unitId, unitName: slot.unitName, date: slot.date, type: slot.isFree ? "opened" : "closed" } as const];
  });

  // Mirrors the service: only changed nights are written, and nights the grid
  // no longer reports are removed.
  const seen = new Set(slots.map((slot) => `${slot.unitId}:${slot.date.toISOString().slice(0, 10)}`));
  const upserts = slots.filter((slot) => {
    const was = before.get(`${slot.unitId}:${slot.date.toISOString().slice(0, 10)}`);
    return was === undefined || was !== slot.isFree;
  });
  const removals = previous
    .filter((p) => !seen.has(`${p.unitId}:${p.date.toISOString().slice(0, 10)}`))
    .map(({ unitId, date }) => ({ unitId, date }));

  await availabilityRepository.applyWindowDelta(facilityId, { upserts, removals }, events);
  return events.length;
}

const allFree = Object.fromEntries(NIGHTS.map((n) => [n, true]));

async function freshFacility(name: string) {
  const park = await createPark({ name: `${name} Park` });
  return createFacility({ name, parkId: park.id });
}

test.describe("availability events", () => {
  test.use({ user: null });

  test("a first-ever scan records nothing — that is discovery, not openings", async () => {
    const facility = await freshFacility("Discovery Camp");

    expect(await scan(facility.id, allFree)).toBe(0);
    expect(await prisma.availabilityEvent.count({ where: { facilityId: facility.id } })).toBe(0);
  });

  test("records one event per flip, and nothing while the state holds", async () => {
    const facility = await freshFacility("Flip Camp");
    await scan(facility.id, allFree); // establish a baseline to diff against

    expect(await scan(facility.id, allFree)).toBe(0);
    expect(await scan(facility.id, { ...allFree, "2026-09-02": false })).toBe(1);
    expect(await scan(facility.id, allFree)).toBe(1);

    // Staying open must not keep producing events — this is the whole dedup guarantee.
    for (let i = 0; i < 3; i++) await scan(facility.id, allFree);

    const events = await prisma.availabilityEvent.findMany({
      where: { facilityId: facility.id },
      orderBy: { detectedAt: "asc" },
    });
    expect(events.map((e) => e.type)).toEqual(["closed", "opened"]);
    expect(events.every((e) => e.date.toISOString().slice(0, 10) === "2026-09-02")).toBe(true);
    // Unsent: the notifier claims these later, which is what makes it a durable outbox.
    expect(events.every((e) => e.notifiedAt === null)).toBe(true);
  });

  test("a night entering the window for the first time is not an opening", async () => {
    const facility = await freshFacility("Rolling Window Camp");
    // Only two of the three nights have ever been seen.
    await scan(facility.id, { "2026-09-01": true, "2026-09-02": true });

    // The third rolls in, free. That is new data, not a cancellation.
    expect(await scan(facility.id, allFree)).toBe(0);
  });
});

test.describe("past-slot prune", () => {
  test.use({ user: null });

  test("drops nights that have already passed and leaves the rest", async () => {
    const park = await createPark({ name: "Prune Park" });
    const facility = await createFacility({ name: "Prune Camp", parkId: park.id });

    const yesterday = new Date();
    yesterday.setUTCHours(0, 0, 0, 0);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const nextWeek = new Date();
    nextWeek.setUTCHours(0, 0, 0, 0);
    nextWeek.setUTCDate(nextWeek.getUTCDate() + 7);

    await createSlots({ facilityId: facility.id, dates: [yesterday, nextWeek] });
    expect(await prisma.availabilitySlot.count({ where: { facilityId: facility.id } })).toBe(2);

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    await availabilityRepository.deleteSlotsBefore(today);

    const left = await prisma.availabilitySlot.findMany({ where: { facilityId: facility.id } });
    expect(left).toHaveLength(1);
    expect(left[0]!.date.toISOString().slice(0, 10)).toBe(nextWeek.toISOString().slice(0, 10));
  });
});
