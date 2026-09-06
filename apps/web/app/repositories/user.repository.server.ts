import { prisma } from "@campingmeow/database";

export const userRepository = {
  async findByEmail(email: string) {
    return prisma.user.findUnique({ where: { email } });
  },

  async findById(id: string) {
    return prisma.user.findUnique({ where: { id } });
  },

  async create(data: { email: string; firstName: string; lastName: string | null }) {
    return prisma.user.create({ data });
  },


  /**
   * Everyone, with what they are actually watching and whether they take email.
   *
   * The admin panel is the only place this runs and there are a handful of
   * users, so pulling the watches inline is cheaper than a second round trip.
   */
  async listAllWithDetail() {
    return prisma.user.findMany({
      include: {
        preference: { select: { emailNotifications: true } },
        watches: {
          where: { active: true },
          orderBy: { createdAt: "desc" },
          include: { facilities: { include: { facility: { include: { park: { select: { name: true } } } } } } },
        },
      },
      orderBy: { createdAt: "desc" },
    });
  },

  async setBanned(id: string, banned: boolean) {
    return prisma.user.update({ where: { id }, data: { bannedAt: banned ? new Date() : null } });
  },

  async count() {
    return prisma.user.count();
  },
};
