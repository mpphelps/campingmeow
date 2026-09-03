import { prisma } from "@campingmeow/database";

export const emailLogRepository = {
  /** One row per notification batch. Powers the emails-per-day metric. */
  async record(quantity: number, metadata: Record<string, string[]>) {
    return prisma.emailLog.create({ data: { quantity, metadata } });
  },

  async countSentSince(since: Date) {
    const result = await prisma.emailLog.aggregate({
      where: { sentAt: { gte: since } },
      _sum: { quantity: true },
    });
    return result._sum.quantity ?? 0;
  },
};
