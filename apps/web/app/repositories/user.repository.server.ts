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


  async listAllWithWatchCounts() {
    return prisma.user.findMany({
      include: { _count: { select: { watches: { where: { active: true } } } } },
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
