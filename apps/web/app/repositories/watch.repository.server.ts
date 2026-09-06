import { prisma } from "@campingmeow/database";

export const watchRepository = {
  async create(data: {
    userId: string;
    facilityIds: string[];
    checkinDays: number[];
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

  async listByUserId(userId: string) {
    return prisma.watch.findMany({
      where: { userId },
      include: { facilities: { include: { facility: { include: { park: true } } } } },
      orderBy: { createdAt: "desc" },
    });
  },

  async delete(id: string) {
    return prisma.watch.delete({ where: { id } });
  },

  async countActiveByUserId(userId: string) {
    return prisma.watch.count({ where: { userId, active: true } });
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
      // Suspended accounts are excluded here rather than at send time: a ban
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
