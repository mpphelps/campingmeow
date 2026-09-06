import { prisma, type FacilityStatus } from "@campingmeow/database";

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

  /** Recorded after every scan, so status is a by-product of work we already do. */
  async setStatus(id: string, status: FacilityStatus, bookableSites: number) {
    return prisma.facility.update({ where: { id }, data: { status, bookableSites } });
  },

  /** Non-bookable campgrounds, for the admin re-check. */
  async listNonBookable() {
    return prisma.facility.findMany({
      where: { active: true, status: { not: "bookable" } },
      select: { id: true, name: true, status: true },
      orderBy: { name: "asc" },
    });
  },

  async countByStatus() {
    const rows = await prisma.facility.groupBy({
      by: ["status"],
      where: { active: true },
      _count: { _all: true },
    });
    return Object.fromEntries(rows.map((r) => [r.status, r._count._all])) as Record<FacilityStatus, number>;
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
   */
  /**
   * The single query the scanner runs to decide what to do next: the most
   * overdue bookable campground, nulls (never scanned) first.
   *
   * There is no watched/unwatched distinction any more. Scanning everything
   * makes scan cost a function of the catalog, which is fixed, rather than of
   * user count, which is not.
   */
  async findMostOverdue(options: { scannedBefore: Date }) {
    return prisma.facility.findFirst({
      where: {
        active: true,
        status: "bookable",
        OR: [{ lastScannedAt: null }, { lastScannedAt: { lt: options.scannedBefore } }],
      },
      orderBy: { lastScannedAt: { sort: "asc", nulls: "first" } },
    });
  },

  /** How many campgrounds are past their freshness target — the backlog size. */
  async countOverdue(options: { scannedBefore: Date }) {
    return prisma.facility.count({
      where: {
        active: true,
        status: "bookable",
        OR: [{ lastScannedAt: null }, { lastScannedAt: { lt: options.scannedBefore } }],
      },
    });
  },

  /** Worst staleness in the catalog: the health number that actually matters. */
  async findOldestScan() {
    return prisma.facility.findFirst({
      where: { active: true, status: "bookable" },
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
