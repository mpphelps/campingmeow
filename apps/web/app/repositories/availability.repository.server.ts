import { prisma, type AvailabilityEventType } from "@campingmeow/database";

export interface SlotInput {
  unitId: number;
  unitName: string;
  date: Date;
  isFree: boolean;
  /** Did RC return a slice for this night? See the column comment in schema.prisma. */
  reported: boolean;
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
      select: { unitId: true, unitName: true, date: true, isFree: true, reported: true },
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
  /**
   * Write only what changed in a facility's window.
   *
   * The old version deleted the whole window and re-inserted it — ~3,200 rows
   * every scan for a mid-size campground, even when nothing had moved since
   * the last pass 25 minutes earlier. That was wasteful on its own, and it put
   * 22,400 bind parameters in a single statement: within Postgres's 65,535
   * limit, but on the way to it for a big campground, and enough that Prisma
   * held on to megabytes of serialised query per call.
   *
   * A steady-state scan now writes a handful of rows. Only a first scan, where
   * every night is new, writes the whole window — and that is chunked.
   */
  async applyWindowDelta(
    facilityId: string,
    delta: { upserts: SlotInput[]; removals: { unitId: number; date: Date }[] },
    events: EventInput[],
  ) {
    const { upserts, removals } = delta;
    // Rewritten rows are deleted first, so an upsert is a delete plus an
    // insert. That avoids one UPDATE per changed night, which would be a round
    // trip each on a first scan.
    const stale = [...removals, ...upserts.map(({ unitId, date }) => ({ unitId, date }))];

    return prisma.$transaction(async (tx) => {
      if (stale.length > 0) {
        // Grouped by unit so the filter stays small: one clause per site with
        // a list of nights, rather than one clause per night.
        const byUnit = new Map<number, Date[]>();
        for (const { unitId, date } of stale) {
          const dates = byUnit.get(unitId) ?? [];
          dates.push(date);
          byUnit.set(unitId, dates);
        }
        await tx.availabilitySlot.deleteMany({
          where: {
            facilityId,
            OR: [...byUnit.entries()].map(([unitId, dates]) => ({ unitId, date: { in: dates } })),
          },
        });
      }

      // Chunked: a first scan inserts the entire window, and one enormous
      // statement is what caused the memory problem this replaced.
      const CHUNK = 500;
      for (let i = 0; i < upserts.length; i += CHUNK) {
        await tx.availabilitySlot.createMany({
          data: upserts.slice(i, i + CHUNK).map((slot) => ({ ...slot, facilityId })),
        });
      }

      if (events.length > 0) {
        await tx.availabilityEvent.createMany({
          data: events.map((event) => ({ ...event, facilityId })),
        });
      }

      await tx.facility.update({ where: { id: facilityId }, data: { lastScannedAt: new Date() } });
    });
  },

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

  /** Just the number. The admin panel polls every 10s and only shows a count. */
  async countUnnotifiedOpenings() {
    return prisma.availabilityEvent.count({ where: { type: "opened", notifiedAt: null } });
  },

  /**
   * The notifier's outbox read: openings nobody has been told about yet,
   * oldest first. Bounded so one pass can't try to email the world.
   */
  /** `facilityId` narrows it to one campground, for the send that happens mid-sweep. */
  async listUnnotifiedOpenings(limit: number, facilityId?: string) {
    return prisma.availabilityEvent.findMany({
      where: { type: "opened", notifiedAt: null, ...(facilityId ? { facilityId } : {}) },
      orderBy: { detectedAt: "desc" },
      take: limit,
      select: { id: true, facilityId: true, unitId: true, unitName: true, date: true },
    });
  },

  /**
   * Stamp every opening still waiting, sent or not.
   *
   * Run at the end of a notifier pass so the next one starts clean. An opening
   * we could not mail — a send that failed, a batch over the limit, a paused
   * quota — is not worth carrying: a sweep takes about 35 minutes, so by the
   * next pass the site has very likely gone, and mailing a booked site is
   * worse than saying nothing. The next sweep will find whatever is open then.
   */
  async markAllOpeningsNotified() {
    const { count } = await prisma.availabilityEvent.updateMany({
      where: { type: "opened", notifiedAt: null },
      data: { notifiedAt: new Date() },
    });
    return count;
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
