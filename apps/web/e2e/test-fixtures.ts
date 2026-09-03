import { test as base } from "@playwright/test";
import { prisma } from "@campingmeow/database";

type AppOptions = {
  user: { email: string; firstName: string; lastName: string; permissions?: string[] } | null;
};

type AppFixtures = {
  cleanDb: void;
};

export const test = base.extend<AppOptions & AppFixtures>({
  user: [null, { option: true }],

  cleanDb: [
    async ({}, use) => {
      // Every table a test can write. AvailabilityEvent would be reached by
      // CASCADE from Facility, but EmailLog has no foreign key at all — leave
      // it out and email counts leak from one test into the next.
      await prisma.$executeRawUnsafe(
        'TRUNCATE "User", "Park", "Facility", "Watch", "WatchFacility", "AvailabilitySlot", "AvailabilityEvent", "EmailLog" CASCADE',
      );
      await use();
    },
    { auto: true },
  ],

  // The page override lists cleanDb in its args. That's intentional even though we don't use the value — it forces fixture ordering.
  page: async ({ page, user, cleanDb }, use) => {
    if (user) {
      const response = await page.request.post("/auth/test-login", {
        data: user,
      });
      if (!response.ok()) {
        throw new Error(`test-login failed: ${response.status()} ${await response.text()}`);
      }
    }
    await use(page);
  },
});

export { expect } from "@playwright/test";
