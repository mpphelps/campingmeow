import { addDays, dayOfWeek, fmt, type ISODate } from "@campingmeow/scanner";
import { EmailQuotaExceededError, emailSender } from "~/lib/email.server";
import { DAILY_EMAIL_LIMIT, EMAIL_QUOTA_WINDOW_MS } from "~/lib/limits";
import { logger } from "~/lib/logger.server";
import { SITE_URL } from "~/lib/site";
import { availabilityRepository } from "../repositories/availability.repository.server";
import { emailLogRepository } from "../repositories/email-log.repository.server";
import { watchRepository } from "../repositories/watch.repository.server";
import { preferenceService } from "./preference.service.server";

/**
 * Turns "a night opened" into "you have mail".
 *
 * Called by the scanner at the end of a sweep, not on a loop of its own. A
 * sweep is exactly the unit of work that produces events, so there is nothing
 * to poll for — and running once per sweep is what batches a user's openings
 * into one email instead of one per campground.
 *
 * `AvailabilityEvent.notifiedAt` makes this a durable outbox. Events are only
 * stamped after a send succeeds, so a provider outage delays mail instead of
 * losing it.
 */

/** Most events to process in one pass, so a backlog can't email the world at once. */
const BATCH_LIMIT = 500;
/** Longest stay a watch can ask for; bounds how far around an opening we look. */
const MAX_NIGHTS = 7;

export interface NotifierStatus {
  /** How the mail actually goes out — "stub" here in production means misconfigured. */
  sender: string;
  pendingEvents: number;
  quota: QuotaStatus;
}

/** What is left of the sending allowance, and when it comes back. */
export interface QuotaStatus {
  /** Emails sent in the trailing 24 hours. */
  sentLast24h: number;
  limit: number;
  remaining: number;
  /** True once the allowance is gone: watches keep running, mail does not go out. */
  paused: boolean;
  /**
   * When the oldest batch in the window ages out and budget returns. Null when
   * nothing has been sent, or when we are not paused.
   */
  resumesAt: string | null;
}

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


export const notificationService = {
  runOnce,
  getStatus,
  getQuotaStatus,
};


async function getStatus(): Promise<NotifierStatus> {
  const [pending, quota] = await Promise.all([
    availabilityRepository.listUnnotifiedOpenings(BATCH_LIMIT),
    getQuotaStatus(),
  ]);
  return { sender: emailSender.name, pendingEvents: pending.length, quota };
}

/**
 * The trailing-window quota. Read by the notifier before each pass and by the
 * home page, which tells people when alerts are paused rather than letting
 * them believe a silent watch means nothing has opened.
 */
async function getQuotaStatus(): Promise<QuotaStatus> {
  const since = new Date(Date.now() - EMAIL_QUOTA_WINDOW_MS);
  const sentLast24h = await emailLogRepository.countSentSince(since);
  const remaining = Math.max(0, DAILY_EMAIL_LIMIT - sentLast24h);
  const paused = remaining === 0;

  let resumesAt: string | null = null;
  if (paused) {
    // Budget returns when the oldest batch inside the window ages out of it.
    const oldest = await emailLogRepository.oldestSentAtSince(since);
    if (oldest) resumesAt = new Date(oldest.getTime() + EMAIL_QUOTA_WINDOW_MS).toISOString();
  }

  return { sentLast24h, limit: DAILY_EMAIL_LIMIT, remaining, paused, resumesAt };
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
  // Events whose mail did not go out. These stay unnotified so the next pass
  // retries them, which is the whole point of the outbox.
  const deferred = new Set<string>();
  const defer = (userMatches: Match[]) => userMatches.forEach((m) => deferred.add(m.eventId));

  let budget = (await getQuotaStatus()).remaining;
  let sent = 0;
  let skippedForQuota = 0;

  for (const [userId, userMatches] of byUser) {
    const email = userMatches[0]!.email;

    if (budget <= 0) {
      // Out of allowance. Hold the openings rather than dropping them: the
      // window is rolling, so budget returns without anyone doing anything.
      defer(userMatches);
      skippedForQuota++;
      continue;
    }

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
      budget--;
      notifiedByUser[userId] = [...new Set(userMatches.map((m) => m.eventId))];
      logger.info({ action: "notifier.sent", userId, openings: userMatches.length }, "opening email sent");
    } catch (err) {
      defer(userMatches);
      if (err instanceof EmailQuotaExceededError) {
        // Resend's own count says we are done, and it outranks ours — it can
        // see mail we didn't send. Stop the pass; everyone left is deferred.
        budget = 0;
        skippedForQuota++;
        logger.warn({ action: "notifier.quota_exhausted", userId, err }, "Resend daily quota exhausted; pausing sends");
        continue;
      }
      logger.warn({ action: "notifier.send_failed", userId, email, err }, "opening email failed to send");
    }
  }

  // Everything except the held-back openings. An event matched by two users,
  // one of whom we could not reach, is held for both — so that user may get a
  // second copy next pass. A duplicate is a far smaller failure than never
  // being told a site opened, which is the one thing this product promises.
  const handled = events.filter((e) => !deferred.has(e.id)).map((e) => e.id);
  if (handled.length > 0) await availabilityRepository.markNotified(handled);
  if (sent > 0) await emailLogRepository.record(sent, notifiedByUser);

  logger.info(
    {
      action: "notifier.pass",
      events: events.length,
      matched: matches.length,
      emails: sent,
      deferred: deferred.size,
      skippedForQuota,
    },
    "notifier pass complete",
  );
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

