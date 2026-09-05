import { prisma } from "@campingmeow/database";
import { randomBytes } from "node:crypto";

/** 32 bytes: not guessable, and short enough to sit in an email URL. */
function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export const userPreferenceRepository = {
  /**
   * Preferences for a user, creating defaults on first read. Lazily created so
   * nothing has to backfill every existing user, and so a user who never
   * touches settings still has a stable unsubscribe token the moment we need
   * to put one in an email.
   */
  async findOrCreateByUserId(userId: string) {
    return prisma.userPreference.upsert({
      where: { userId },
      update: {},
      create: { userId, unsubscribeToken: newToken() },
    });
  },

  /** The logged-out path: identify someone purely by the token in their email. */
  async findByToken(unsubscribeToken: string) {
    return prisma.userPreference.findUnique({
      where: { unsubscribeToken },
      include: { user: { select: { id: true, email: true, firstName: true } } },
    });
  },

  async setEmailNotifications(userId: string, emailNotifications: boolean) {
    return prisma.userPreference.upsert({
      where: { userId },
      update: { emailNotifications },
      create: { userId, emailNotifications, unsubscribeToken: newToken() },
    });
  },

  /** Invalidates every unsubscribe link previously sent to this user. */
  async rotateToken(userId: string) {
    return prisma.userPreference.update({
      where: { userId },
      data: { unsubscribeToken: newToken() },
    });
  },
};
