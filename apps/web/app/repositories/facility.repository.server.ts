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

  async listActiveByParkId(parkId: string) {
    return prisma.facility.findMany({
      where: { parkId, active: true },
      orderBy: { name: "asc" },
    });
  },
};
