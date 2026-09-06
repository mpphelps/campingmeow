// Small date helpers. We work in plain "yyyy-MM-dd" strings in UTC to avoid
// timezone surprises (a campsite night has no time-of-day component).

export type ISODate = string; // "yyyy-MM-dd"

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export type DayName = (typeof DOW)[number];

export function parse(d: ISODate): Date {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day));
}

export function fmt(date: Date): ISODate {
  return date.toISOString().slice(0, 10);
}

export function addDays(d: ISODate, n: number): ISODate {
  const date = parse(d);
  date.setUTCDate(date.getUTCDate() + n);
  return fmt(date);
}

export function dayOfWeek(d: ISODate): DayName {
  return DOW[parse(d).getUTCDay()];
}


/** Inclusive list of dates from `start` to `end`. */
export function eachDay(start: ISODate, end: ISODate): ISODate[] {
  const out: ISODate[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Format a check-in nicely, e.g. "Sat 2026-08-15". */
export function label(d: ISODate): string {
  return `${dayOfWeek(d)} ${d}`;
}
