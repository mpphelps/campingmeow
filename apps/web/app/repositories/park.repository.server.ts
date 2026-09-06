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

  /** Every active park that has at least one active campground. Filtering is
   *  done in the browser on the home page, so there is no query here. */
  async listActiveWithFacilities() {
    return prisma.park.findMany({
      where: {
        active: true,
        facilities: { some: { active: true } },
      },
      include: { facilities: { where: { active: true }, orderBy: { name: "asc" } } },
      orderBy: { name: "asc" },
    });
  },

  async findById(id: string) {
    return prisma.park.findUnique({ where: { id } });
  },

  async countActive() {
    return prisma.park.count({ where: { active: true } });
  },
};
