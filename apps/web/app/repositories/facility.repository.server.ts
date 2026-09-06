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
  async setStatus(
    id: string,
    status: FacilityStatus,
    bookableSites: number,
    siteInfo: { siteCategories: number[]; maxVehicleLength: number },
  ) {
    return prisma.facility.update({ where: { id }, data: { status, bookableSites, ...siteInfo } });
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

  /** The one query the sweep needs: everything worth scanning, in a stable order. */
  /** The sweep's work list. Park name rides along so admin can show where it is. */
  async listBookable() {
    return prisma.facility.findMany({
      where: { active: true, status: "bookable" },
      // lastScannedAt is how a resumed cycle knows what it already covered.
      select: { id: true, name: true, lastScannedAt: true, park: { select: { name: true } } },
      // By park, then name. Ordering by the cuid primary key was stable but
      // looked random on the admin panel, which made a sweep impossible to
      // follow — you could not tell progress from thrashing.
      orderBy: [{ park: { name: "asc" } }, { name: "asc" }],
    });
  },

  /** How many campgrounds are past their freshness target — the backlog size. */



  async listActiveByParkId(parkId: string) {
    return prisma.facility.findMany({
      where: { parkId, active: true },
      orderBy: { name: "asc" },
    });
  },
};
