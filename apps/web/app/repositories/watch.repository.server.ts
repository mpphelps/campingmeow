import { prisma } from "@campingmeow/database";

export const watchRepository = {
  async create(data: {
    userId: string;
    facilityIds: string[];
    checkinDays: number[];
    nights: number;
    startDate: Date | null;
    endDate: Date | null;
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

  async countActive() {
    return prisma.watch.count({ where: { active: true } });
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
