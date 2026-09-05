import { addDays, dayOfWeek, fmt, type ISODate } from "@campingmeow/scanner";
import { emailSender } from "~/lib/email.server";
import { logger } from "~/lib/logger.server";
import { availabilityRepository } from "../repositories/availability.repository.server";
import { emailLogRepository } from "../repositories/email-log.repository.server";
import { watchRepository } from "../repositories/watch.repository.server";
import { preferenceService } from "./preference.service.server";

/**
 * Turns "a night opened" into "you have mail".
 *
 * Runs on its own loop rather than hanging off a scan: the scanner has no
 * discrete sweeps to finish, and batching is the point — a user watching 20
 * campgrounds would otherwise get 20 separate emails as the scanner works
 * through them.
 *
 * `AvailabilityEvent.notifiedAt` makes this a durable outbox. Events are only
 * stamped after a send succeeds, so a provider outage delays mail instead of
 * losing it.
 */

/** How often to look for openings to report. */
const INTERVAL_MS = 10 * 60 * 1000;
/** Most events to process in one pass, so a backlog can't email the world at once. */
const BATCH_LIMIT = 500;
/** Longest stay a watch can ask for; bounds how far around an opening we look. */
const MAX_NIGHTS = 7;

export interface NotifierStatus {
  running: boolean;
  /** How the mail actually goes out — "stub" here in production means misconfigured. */
  sender: string;
  pendingEvents: number;
  emailsSentToday: number;
}

/** Where the unsubscribe link points. */
const SITE_URL = process.env.SITE_URL ?? "https://campingmeow.com";

/** One stay worth telling someone about. */
interface Match {
  /** The opening that produced this match, for the EmailLog metadata. */
  eventId: string;
  userId: string;
  email: string;
  parkName: string;
  facilityName: string;
  siteName: string;
  checkin: ISODate;
  nights: number;
}

let started = false;

export const notificationService = {
  start,
  runOnce,
  getStatus,
};

function start(): void {
  if (started) return;
  if (process.env.DISABLE_NOTIFIER === "1") {
    logger.info({ action: "notifier.disabled" }, "notifier disabled by DISABLE_NOTIFIER");
    return;
  }
  started = true;
  logger.info({ action: "notifier.start", intervalMinutes: INTERVAL_MS / 60000, sender: emailSender.name }, "notifier started");
  void loop();
}

async function getStatus(): Promise<NotifierStatus> {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const [pending, emailsSentToday] = await Promise.all([
    availabilityRepository.listUnnotifiedOpenings(BATCH_LIMIT),
    emailLogRepository.countSentSince(midnight),
  ]);
  return { running: started, sender: emailSender.name, pendingEvents: pending.length, emailsSentToday };
}

async function loop(): Promise<void> {
  for (;;) {
    try {
      await runOnce();
    } catch (err) {
      logger.error({ action: "notifier.pass_failed", err }, "notifier pass failed");
    }
    await sleep(INTERVAL_MS);
  }
}

/**
 * One pass: claim unreported openings, work out who wanted them, send one
 * email per person, then mark the events handled.
 */
async function runOnce(): Promise<{ events: number; emails: number }> {
  const events = await availabilityRepository.listUnnotifiedOpenings(BATCH_LIMIT);
  if (events.length === 0) return { events: 0, emails: 0 };

  const facilityIds = [...new Set(events.map((e) => e.facilityId))];
  const watches = await watchRepository.listActiveByFacilityIds(facilityIds);
  if (watches.length === 0) {
    // Nobody is watching these campgrounds — still mark them handled, or the
    // notifier re-examines the same events every ten minutes forever.
    await availabilityRepository.markNotified(events.map((e) => e.id));
    return { events: events.length, emails: 0 };
  }

  const freeNights = await loadFreeNights(events);
  const matches = findMatches(events, watches, freeNights);

  const byUser = new Map<string, Match[]>();
  for (const match of matches) {
    const list = byUser.get(match.userId) ?? [];
    list.push(match);
    byUser.set(match.userId, list);
  }

  // Which events each user was told about — the EmailLog metadata.
  const notifiedByUser: Record<string, string[]> = {};
  let sent = 0;

  for (const [userId, userMatches] of byUser) {
    const email = userMatches[0]!.email;
    try {
      // Watches keep running when email is off — the user just isn't told, and
      // can still see openings in-app. So this skips the send, not the scan.
      const prefs = await preferenceService.getForUser(userId);
      if (!prefs.emailNotifications) {
        logger.info({ action: "notifier.skipped_opted_out", userId }, "user has email notifications off");
        continue;
      }

      const token = await preferenceService.getUnsubscribeToken(userId);
      await emailSender.send(buildEmail(userMatches, token));
      sent++;
      notifiedByUser[userId] = [...new Set(userMatches.map((m) => m.eventId))];
      logger.info({ action: "notifier.sent", userId, openings: userMatches.length }, "opening email sent");
    } catch (err) {
      // Leave this user's events unnotified so the next pass retries them.
      logger.warn({ action: "notifier.send_failed", userId, email, err }, "opening email failed to send");
    }
  }

  await availabilityRepository.markNotified(events.map((e) => e.id));
  if (sent > 0) await emailLogRepository.record(sent, notifiedByUser);

  logger.info({ action: "notifier.pass", events: events.length, matched: matches.length, emails: sent }, "notifier pass complete");
  return { events: events.length, emails: sent };
}

/**
 * Free nights for every campground with an opening, across a window wide
 * enough to cover any stay an opening could belong to (up to 6 nights either
 * side of it).
 */
async function loadFreeNights(events: { facilityId: string; date: Date }[]): Promise<Set<string>> {
  const dates = events.map((e) => e.date.getTime());
  const from = new Date(Math.min(...dates));
  const to = new Date(Math.max(...dates));
  from.setUTCDate(from.getUTCDate() - (MAX_NIGHTS - 1));
  to.setUTCDate(to.getUTCDate() + (MAX_NIGHTS - 1));

  const slots = await availabilityRepository.listFreeSlots([...new Set(events.map((e) => e.facilityId))], from, to);
  return new Set(slots.map((s) => nightKey(s.facilityId, s.unitId, fmt(s.date))));
}

/**
 * An event is one *night*; a watch wants a *stay*. A night opening can be the
 * last piece of a multi-night stay whose other nights were already free — so
 * for each opening we check the check-in dates that night could belong to, and
 * confirm the whole stay is free on that one site.
 */
function findMatches(
  events: { id: string; facilityId: string; unitId: number; unitName: string; date: Date }[],
  watches: Awaited<ReturnType<typeof watchRepository.listActiveByFacilityIds>>,
  freeNights: Set<string>,
): Match[] {
  const matches: Match[] = [];
  // Two nights of the same stay can open in one scan, pointing at the same
  // stay. Without this the user gets told twice in one email.
  const seen = new Set<string>();

  for (const event of events) {
    const opened = fmt(event.date);

    for (const watch of watches) {
      const covered = watch.facilities.find((wf) => wf.facilityId === event.facilityId);
      if (!covered) continue;

      for (let offset = 0; offset < watch.nights; offset++) {
        // The opened night could be any night of the stay, so walk back over
        // every check-in date that would include it.
        const checkin = addDays(opened, -offset);
        if (!watch.checkinDays.includes(dayOfWeekIndex(checkin))) continue;

        if (!stayIsFree(freeNights, event.facilityId, event.unitId, checkin, watch.nights)) continue;

        const key = `${watch.id}:${event.unitId}:${checkin}`;
        if (seen.has(key)) continue;
        seen.add(key);

        matches.push({
          eventId: event.id,
          userId: watch.user.id,
          email: watch.user.email,
          parkName: covered.facility.park.name,
          facilityName: covered.facility.name,
          siteName: event.unitName,
          checkin,
          nights: watch.nights,
        });
      }
    }
  }
  return matches;
}

function stayIsFree(freeNights: Set<string>, facilityId: string, unitId: number, checkin: ISODate, nights: number): boolean {
  for (let i = 0; i < nights; i++) {
    if (!freeNights.has(nightKey(facilityId, unitId, addDays(checkin, i)))) return false;
  }
  return true;
}

function buildEmail(matches: Match[], unsubscribeToken: string) {
  const manageUrl = `${SITE_URL}/preferences?token=${encodeURIComponent(unsubscribeToken)}`;
  const lines = matches
    .sort((a, b) => a.checkin.localeCompare(b.checkin))
    .map(
      (m) =>
        `  ${dayOfWeek(m.checkin)} ${m.checkin} · ${m.nights} night${m.nights === 1 ? "" : "s"}\n` +
        `  ${m.parkName} — ${m.facilityName}, site ${m.siteName}`,
    );

  const count = matches.length;
  return {
    to: matches[0]!.email,
    subject: count === 1 ? `A campsite just opened: ${matches[0]!.facilityName}` : `${count} campsites just opened`,
    text: [
      count === 1 ? "A site matching your watch just opened up:" : `${count} sites matching your watch just opened up:`,
      "",
      lines.join("\n\n"),
      "",
      "These go fast — book on ReserveCalifornia:",
      "https://www.reservecalifornia.com/",
      "",
      "You're getting this because you set up a watch on CampingMeow.",
      `Turn these emails off: ${manageUrl}`,
    ].join("\n"),
    headers: {
      // RFC 8058. The POST variant is what lets Gmail's native Unsubscribe
      // button act immediately — link prefetchers only ever issue GETs, so the
      // in-body link above deliberately just opens the page.
      "List-Unsubscribe": `<${manageUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}


function nightKey(facilityId: string, unitId: number, date: ISODate): string {
  return `${facilityId}:${unitId}:${date}`;
}

const DAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function dayOfWeekIndex(date: ISODate): number {
  return DAY_INDEX[dayOfWeek(date)]!;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
