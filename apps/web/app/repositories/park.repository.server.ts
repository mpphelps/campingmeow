import { prisma } from "@campingmeow/database";

export const parkRepository = {
  async upsertByRcPlaceId(data: {
    rcPlaceId: number;
    name: string;
    city: string | null;
    latitude: number | null;
    longitude: number | null;
    allowWebBooking: boolean;
  }) {
    return prisma.park.upsert({
      where: { rcPlaceId: data.rcPlaceId },
      create: { ...data, active: true },
      update: { ...data, active: true },
    });
  },

  async deactivateMissing(seenRcPlaceIds: number[]) {
    const result = await prisma.park.updateMany({
      where: { rcPlaceId: { notIn: seenRcPlaceIds }, active: true },
      data: { active: false },
    });
    return result.count;
  },

  async listActive() {
    return prisma.park.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
    });
  },
};
