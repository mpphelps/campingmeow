/**
 * The two kinds of watch, and the one question both have to answer: does this
 * watch want a stay starting on this date?
 *
 *   pattern — `checkinDays`, weekdays (0=Sun .. 6=Sat), every match in the window
 *   dates   — `checkinDates`, exactly these check-ins (yyyy-MM-dd)
 *
 * Kept in one place because the notifier and the /watches calendar both ask
 * it, and if they ever answered differently someone would be emailed about a
 * night their calendar doesn't show — or the reverse.
 */

export type WatchMode = "pattern" | "dates";

export interface WatchSchedule {
  checkinDays: number[];
  /** yyyy-MM-dd. Non-empty means this is a dates watch. */
  checkinDates: string[];
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function modeOf(schedule: WatchSchedule): WatchMode {
  return schedule.checkinDates.length > 0 ? "dates" : "pattern";
}

export function wantsCheckin(schedule: WatchSchedule, checkin: string): boolean {
  if (schedule.checkinDates.length > 0) return schedule.checkinDates.includes(checkin);
  return schedule.checkinDays.includes(new Date(`${checkin}T00:00:00Z`).getUTCDay());
}

/**
 * A dates watch expires once every check-in has passed. A check-in today still
 * counts — tonight can still be booked.
 *
 * Derived, never stored: there is no status column to keep in sync and no job
 * to run, and the notifier needs no special case because a past check-in can
 * never match anything in the scanned window.
 */
export function isExpired(checkinDates: string[], today: string): boolean {
  return checkinDates.length > 0 && checkinDates.every((date) => date < today);
}

/** Postgres DATE columns come back as UTC-midnight Dates. */
export function toIsoDates(dates: Date[]): string[] {
  return dates.map((date) => date.toISOString().slice(0, 10)).sort();
}

/** "Fri Oct 16" */
export function checkinLabel(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  return `${WEEKDAYS[date.getUTCDay()]} ${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}
