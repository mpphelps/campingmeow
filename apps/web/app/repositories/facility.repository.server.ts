import { prisma } from "@campingmeow/database";

export const facilityRepository = {
  async upsertByRcFacilityId(data: {
    rcFacilityId: number;
    name: string;
    facilityType: number | null;
    allowWebBooking: boolean;
    parkId: string;
  }) {
    return prisma.facility.upsert({
      where: { rcFacilityId: data.rcFacilityId },
      create: { ...data, active: true },
      update: { ...data, active: true },
    });
  },

  async deactivateMissing(seenRcFacilityIds: number[]) {
    const result = await prisma.facility.updateMany({
      where: { rcFacilityId: { notIn: seenRcFacilityIds }, active: true },
      data: { active: false },
    });
    return result.count;
  },

  async findByIdWithPark(id: string) {
    return prisma.facility.findUnique({ where: { id }, include: { park: true } });
  },

  async findById(id: string) {
    return prisma.facility.findUnique({
      where: { id },
      include: { park: true },
    });
  },

  async countActive() {
    return prisma.facility.count({ where: { active: true } });
  },

  async listActiveByIds(ids: string[]) {
    return prisma.facility.findMany({
      where: { id: { in: ids }, active: true },
    });
  },

  async listActiveWithPark(filter?: { parkIds?: string[]; facilityIds?: string[] }) {
    return prisma.facility.findMany({
      where: {
        active: true,
        ...(filter?.parkIds ? { parkId: { in: filter.parkIds } } : {}),
        ...(filter?.facilityIds ? { id: { in: filter.facilityIds } } : {}),
      },
      include: { park: true },
      orderBy: { name: "asc" },
    });
  },

  /**
   * The single query the scanner runs to decide what to do next: the most
   * overdue campground, nulls (never scanned) first.
   *
   * `watchedOnly` narrows to campgrounds covered by an active watch. Passing a
   * cutoff of `null` means "any age" — used to drain a backlog.
   */
  async findMostOverdue(options: { watchedOnly: boolean; scannedBefore: Date }) {
    return prisma.facility.findFirst({
      where: {
        active: true,
        OR: [{ lastScannedAt: null }, { lastScannedAt: { lt: options.scannedBefore } }],
        ...(options.watchedOnly ? { watches: { some: { watch: { active: true } } } } : {}),
      },
      orderBy: { lastScannedAt: { sort: "asc", nulls: "first" } },
    });
  },

  /** How many campgrounds are past their freshness target — the backlog size. */
  async countOverdue(options: { watchedOnly: boolean; scannedBefore: Date }) {
    return prisma.facility.count({
      where: {
        active: true,
        OR: [{ lastScannedAt: null }, { lastScannedAt: { lt: options.scannedBefore } }],
        ...(options.watchedOnly ? { watches: { some: { watch: { active: true } } } } : {}),
      },
    });
  },

  /** Worst staleness in the catalog: the health number that actually matters. */
  async findOldestScan(options: { watchedOnly: boolean }) {
    return prisma.facility.findFirst({
      where: {
        active: true,
        ...(options.watchedOnly ? { watches: { some: { watch: { active: true } } } } : {}),
      },
      orderBy: { lastScannedAt: { sort: "asc", nulls: "first" } },
      select: { name: true, lastScannedAt: true },
    });
  },

  /** Campgrounds scanned since `since` — throughput, derived not counted. */
  async countScannedSince(since: Date) {
    return prisma.facility.count({ where: { lastScannedAt: { gte: since } } });
  },

  async listActiveByParkId(parkId: string) {
    return prisma.facility.findMany({
      where: { parkId, active: true },
      orderBy: { name: "asc" },
    });
  },
};
