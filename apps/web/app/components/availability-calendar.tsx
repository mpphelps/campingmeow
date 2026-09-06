import { useState } from "react";

import { Alert } from "@campingmeow/ui/components/alert";
import { Calendar } from "@campingmeow/ui/components/calendar";
import { timeAgo } from "~/lib/time";

/**
 * A month of availability, one month at a time.
 *
 * Read-only: no `mode`, so react-day-picker renders days as plain cells with no
 * selection state. Availability is a `modifier`, which keeps the "which days
 * are free" decision entirely in the service — this component just colours what
 * it's given.
 */
export interface AvailabilityCalendarProps {
  /** yyyy-MM-dd nights to mark available. */
  freeDates: string[];
  /** Null = never scanned. An empty calendar then means "unknown", not "full". */
  lastScannedAt: string | null;
  /** yyyy-MM-dd bounds of what we actually hold data for. */
  windowStart: string;
  windowEnd: string;
  /** What a green day means here — the two pages define it differently. */
  legend: string;
}

/** Parse yyyy-MM-dd as a local date, so a day never shifts across a timezone. */
function toLocalDate(iso: string): Date {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year!, month! - 1, day!);
}

export function AvailabilityCalendar({
  freeDates,
  lastScannedAt,
  windowStart,
  windowEnd,
  legend,
}: AvailabilityCalendarProps) {
  const [month, setMonth] = useState(() => toLocalDate(windowStart));

  if (!lastScannedAt) {
    return (
      <Alert variant="warning">
        We haven&apos;t checked this campground yet, so we have nothing to show. Set a watch and we&apos;ll start tracking it
        right away.
      </Alert>
    );
  }

  const available = freeDates.map(toLocalDate);
  const start = toLocalDate(windowStart);
  const end = toLocalDate(windowEnd);

  return (
    <div>
      <Calendar
        month={month}
        onMonthChange={setMonth}
        startMonth={start}
        endMonth={end}
        // Beyond our window we have no data — that is different from "booked",
        // so those days are dimmed rather than shown as unavailable.
        disabled={{ before: start, after: end }}
        modifiers={{ available }}
        // Targets the day wrapper, not the cell — see the Calendar primitive.
        // Painting the cell would bleed into its padding and merge runs of
        // available days into one solid bar.
        modifiersClassNames={{
          available: "[&>div]:bg-primary/15 [&>div]:font-semibold [&>div]:text-primary",
          disabled: "text-muted-foreground/30",
        }}
      />

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="size-3 rounded-sm bg-primary/15 ring-1 ring-primary/30" />
          {legend}
        </span>
        <span>
          Last checked <time dateTime={lastScannedAt}>{timeAgo(lastScannedAt)}</time>
        </span>
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        A snapshot, not live — sites can be taken between checks. Book on ReserveCalifornia to be sure.
      </p>
    </div>
  );
}

