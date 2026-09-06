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

  /**
   * When the oldest batch still inside the window was sent.
   *
   * The quota window is a trailing 24 hours, so this is what says when budget
   * frees up again: that batch ages out first.
   */
  async oldestSentAtSince(since: Date): Promise<Date | null> {
    const row = await prisma.emailLog.findFirst({
      where: { sentAt: { gte: since } },
      orderBy: { sentAt: "asc" },
      select: { sentAt: true },
    });
    return row?.sentAt ?? null;
  },
};
