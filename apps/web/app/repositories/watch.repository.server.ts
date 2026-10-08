import { prisma } from "@campingmeow/database";

export const watchRepository = {
  async create(data: {
    userId: string;
    facilityIds: string[];
    checkinDays: number[];
    checkinDates: Date[];
    nights: number;
  }) {
    const { facilityIds, ...watch } = data;
    return prisma.watch.create({
      data: {
        ...watch,
        facilities: { create: facilityIds.map((facilityId) => ({ facilityId })) },
      },
      include: { facilities: { include: { facility: { include: { park: true } } } } },
    });
  },

  async findById(id: string) {
    return prisma.watch.findUnique({ where: { id } });
  },

  /** For the edit form: the watch as it stands, campgrounds included. */
  async findByIdWithFacilities(id: string) {
    return prisma.watch.findUnique({
      where: { id },
      include: { facilities: { include: { facility: { include: { park: true } } } } },
    });
  },

  /**
   * Replace a watch's schedule and campgrounds in one step. The campground list
   * is swapped wholesale — simpler than diffing, and a watch holds at most 20.
   */
  async update(
    id: string,
    data: { facilityIds: string[]; checkinDays: number[]; checkinDates: Date[]; nights: number },
  ) {
    const { facilityIds, ...schedule } = data;
    return prisma.watch.update({
      where: { id },
      data: {
        ...schedule,
        facilities: { deleteMany: {}, create: facilityIds.map((facilityId) => ({ facilityId })) },
      },
      include: { facilities: { include: { facility: { include: { park: true } } } } },
    });
  },

  async listByUserId(userId: string) {
    return prisma.watch.findMany({
      where: { userId },
      include: { facilities: { include: { facility: { include: { park: true } } } } },
      orderBy: { createdAt: "desc" },
    });
  },

  async setActive(id: string, active: boolean) {
    return prisma.watch.update({ where: { id }, data: { active } });
  },

  async delete(id: string) {
    return prisma.watch.delete({ where: { id } });
  },

  async countActive() {
    return prisma.watch.count({ where: { active: true } });
  },

  /**
   * Active watches covering any of these campgrounds, with the owner's email —
   * everything the notifier needs to decide who to tell.
   */
  async listActiveByFacilityIds(facilityIds: string[]) {
    return prisma.watch.findMany({
      // Banned accounts are excluded here rather than at send time: a ban
      // should stop the mail, and the watch itself is left intact so it works
      // again if the account is restored.
      where: {
        active: true,
        user: { bannedAt: null },
        facilities: { some: { facilityId: { in: facilityIds } } },
      },
      include: {
        user: { select: { id: true, email: true, firstName: true } },
        facilities: { include: { facility: { include: { park: true } } } },
      },
    });
  },

  async listWatchedFacilityIds() {
    const rows = await prisma.watchFacility.findMany({
      where: { watch: { active: true } },
      distinct: ["facilityId"],
      select: { facilityId: true },
    });
    return rows.map((r) => r.facilityId);
  },
};
