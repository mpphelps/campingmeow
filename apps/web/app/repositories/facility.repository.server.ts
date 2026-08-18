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

  async listActiveByParkId(parkId: string) {
    return prisma.facility.findMany({
      where: { parkId, active: true },
      orderBy: { name: "asc" },
    });
  },
};
