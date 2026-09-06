import { prisma, type AvailabilityEventType } from "@campingmeow/database";

export interface SlotInput {
  unitId: number;
  unitName: string;
  date: Date;
  isFree: boolean;
}

export interface EventInput {
  unitId: number;
  unitName: string;
  date: Date;
  type: AvailabilityEventType;
}

export const availabilityRepository = {
  /** The "before" picture a scan diffs against. */
  async listWindow(facilityId: string, windowStart: Date, windowEnd: Date) {
    return prisma.availabilitySlot.findMany({
      where: { facilityId, date: { gte: windowStart, lte: windowEnd } },
      select: { unitId: true, date: true, isFree: true },
    });
  },

  /**
   * Replace a facility's known availability for a date window and record the
   * transitions that came with it. Scans return the full window each time, so
   * a delete-then-insert keeps the table in step with reality (sites that
   * vanish from the grid don't linger).
   *
   * Events and slots are written in one transaction on purpose. Split them and
   * a partial failure either emails about a state we never stored, or wipes
   * the window so the next scan treats everything as first-time discovery and
   * silently emits nothing — losing the opening for good.
   */
  async replaceWindow(
    facilityId: string,
    windowStart: Date,
    windowEnd: Date,
    slots: SlotInput[],
    events: EventInput[],
  ) {
    return prisma.$transaction([
      prisma.availabilitySlot.deleteMany({
        where: { facilityId, date: { gte: windowStart, lte: windowEnd } },
      }),
      prisma.availabilitySlot.createMany({
        data: slots.map((slot) => ({ ...slot, facilityId })),
      }),
      prisma.availabilityEvent.createMany({
        data: events.map((event) => ({ ...event, facilityId })),
      }),
      prisma.facility.update({
        where: { id: facilityId },
        data: { lastScannedAt: new Date() },
      }),
    ]);
  },

  /**
   * Drop slots for nights that have already passed. Run as its own daily step,
   * not per scan: `replaceWindow` only touches today onward, so past dates
   * orphan at roughly 25k rows/day across the catalog. Trend data lives in
   * AvailabilityEvent, which is why dropping these is not a loss.
   */
  /** The far edge of the window: rows the scanner will never rewrite again. */
  async deleteSlotsAfter(date: Date) {
    const { count } = await prisma.availabilitySlot.deleteMany({ where: { date: { gt: date } } });
    return count;
  },

  async deleteSlotsBefore(date: Date) {
    const { count } = await prisma.availabilitySlot.deleteMany({ where: { date: { lt: date } } });
    return count;
  },

  async listFreeSlots(facilityIds: string[], windowStart: Date, windowEnd: Date) {
    return prisma.availabilitySlot.findMany({
      where: {
        facilityId: { in: facilityIds },
        isFree: true,
        date: { gte: windowStart, lte: windowEnd },
      },
      select: { facilityId: true, unitId: true, unitName: true, date: true },
      orderBy: { date: "asc" },
    });
  },

  /**
   * How many sites are free per campground per night.
   *
   * The nearby grid needs one number per (campground, night) and nothing else,
   * so the count is done in Postgres. Pulling the raw slots instead would be
   * ~70,000 rows for a wide radius against ~9,500 here, and the grid would
   * throw away the per-site detail anyway.
   *
   * Rides the [facilityId, date, isFree] index.
   */
  async countFreeByFacilityAndDate(facilityIds: string[], windowStart: Date, windowEnd: Date) {
    return prisma.availabilitySlot.groupBy({
      by: ["facilityId", "date"],
      where: {
        facilityId: { in: facilityIds },
        isFree: true,
        date: { gte: windowStart, lte: windowEnd },
      },
      _count: { _all: true },
    });
  },

  /**
   * The notifier's outbox read: openings nobody has been told about yet,
   * oldest first. Bounded so one pass can't try to email the world.
   */
  async listUnnotifiedOpenings(limit: number) {
    return prisma.availabilityEvent.findMany({
      where: { type: "opened", notifiedAt: null },
      orderBy: { detectedAt: "asc" },
      take: limit,
      select: { id: true, facilityId: true, unitId: true, unitName: true, date: true },
    });
  },

  /**
   * Mark events handled. Called for *every* claimed event, matched or not —
   * an unmatched opening is still processed, and leaving it would make the
   * notifier re-examine it forever.
   */
  async markNotified(eventIds: string[]) {
    if (eventIds.length === 0) return 0;
    const { count } = await prisma.availabilityEvent.updateMany({
      where: { id: { in: eventIds } },
      data: { notifiedAt: new Date() },
    });
    return count;
  },

};
