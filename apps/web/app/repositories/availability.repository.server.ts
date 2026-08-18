import { prisma } from "@campingmeow/database";

export const availabilityRepository = {
  /**
   * Replace a facility's known availability for a date window. Scans return
   * the full window each time, so a delete-then-insert keeps the table in
   * step with reality (sites that vanish from the grid don't linger).
   */
  async replaceWindow(
    facilityId: string,
    windowStart: Date,
    windowEnd: Date,
    slots: { unitId: number; unitName: string; date: Date; isFree: boolean }[],
  ) {
    return prisma.$transaction([
      prisma.availabilitySlot.deleteMany({
        where: { facilityId, date: { gte: windowStart, lte: windowEnd } },
      }),
      prisma.availabilitySlot.createMany({
        data: slots.map((slot) => ({ ...slot, facilityId })),
      }),
      prisma.facility.update({
        where: { id: facilityId },
        data: { lastScannedAt: new Date() },
      }),
    ]);
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

  async countByFacility(facilityIds: string[]) {
    return prisma.availabilitySlot.groupBy({
      by: ["facilityId"],
      where: { facilityId: { in: facilityIds } },
      _count: { _all: true },
    });
  },
};
