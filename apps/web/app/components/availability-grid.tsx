import { Link } from "react-router";

import { Checkbox } from "@campingmeow/ui/components/checkbox";
import { SiteTypeIcons } from "~/components/site-type-icons";
import type { SiteType } from "~/lib/site-types";

/**
 * Campgrounds down the side, the next nine weeks across the top, shaded by how
 * many sites are free each night.
 *
 * A grid rather than a list because we deliberately do not know when someone
 * wants to go — filtering to weekends would be us guessing. Showing every night
 * at once lets people find their own dates, and the shape of the availability
 * (a solid block in late October, scattered singles next week) is information a
 * list of dates cannot carry.
 *
 * The grid is wide by nature, so it scrolls inside itself with the campground
 * column pinned. The page never scrolls sideways.
 */

export interface GridCampground {
  facilityId: string;
  facilityName: string;
  parkId: string;
  parkName: string;
  distanceMiles: number;
  siteTypes: SiteType[];
  freeByDate: Record<string, number>;
  openNights: number;
}

interface Props {
  dates: string[];
  campgrounds: GridCampground[];
  selected: Set<string>;
  onToggle: (facilityId: string, checked: boolean) => void;
}

/** Absolute counts, not a share of the campground. "Can I get a spot" is the question. */
function densityClass(free: number | undefined): string {
  if (!free) return "bg-transparent";
  if (free <= 2) return "bg-poppy/25";
  if (free <= 5) return "bg-poppy/45";
  if (free <= 10) return "bg-poppy/70";
  return "bg-poppy";
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Parsed as UTC so a yyyy-MM-dd never lands on the previous day west of Greenwich. */
function parseDate(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

function isWeekend(iso: string): boolean {
  const day = parseDate(iso).getUTCDay();
  return day === 0 || day === 6;
}

function describe(iso: string): string {
  const date = parseDate(iso);
  return `${DAY_NAMES[date.getUTCDay()]} ${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

/** Month bands across the top: one header cell per month, spanning its nights. */
function monthSpans(dates: string[]): { label: string; span: number }[] {
  const spans: { label: string; span: number }[] = [];
  for (const iso of dates) {
    const label = MONTHS[parseDate(iso).getUTCMonth()]!;
    const last = spans[spans.length - 1];
    if (last && last.label === label) last.span++;
    else spans.push({ label, span: 1 });
  }
  return spans;
}

export function AvailabilityGrid({ dates, campgrounds, selected, onToggle }: Props) {
  const months = monthSpans(dates);

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="border-separate border-spacing-0 text-sm">
        <thead>
          <tr>
            {/* Pinned so the campground stays readable while the dates scroll. */}
            <th
              scope="col"
              className="sticky left-0 z-20 min-w-[15rem] border-b border-r bg-card px-3 py-1.5 text-left font-medium"
            >
              Campground
            </th>
            {months.map((month, i) => (
              <th
                key={`${month.label}-${i}`}
                colSpan={month.span}
                scope="colgroup"
                className="border-b border-l bg-card px-1 py-1.5 text-left text-xs font-medium text-muted-foreground"
              >
                {month.label}
              </th>
            ))}
          </tr>
          <tr>
            <th scope="col" className="sticky left-0 z-20 border-b border-r bg-card px-3 py-1 text-left">
              <span className="sr-only">Campground</span>
            </th>
            {dates.map((iso) => {
              const date = parseDate(iso);
              // Every day number would be unreadable at this width, so only
              // Sundays are labelled — enough to locate a week at a glance.
              const label = date.getUTCDay() === 0 ? date.getUTCDate() : "";
              return (
                <th
                  key={iso}
                  scope="col"
                  className={`w-[13px] border-b p-0 text-center text-[9px] font-normal text-muted-foreground ${
                    isWeekend(iso) ? "bg-muted/60" : ""
                  }`}
                >
                  <span aria-hidden="true">{label}</span>
                  <span className="sr-only">{describe(iso)}</span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {campgrounds.map((campground) => (
            <tr key={campground.facilityId} className="group">
              <th scope="row" className="sticky left-0 z-10 border-b border-r bg-card px-3 py-1 text-left font-normal">
                <span className="flex items-center gap-2">
                  <Checkbox
                    checked={selected.has(campground.facilityId)}
                    onCheckedChange={(checked) => onToggle(campground.facilityId, checked === true)}
                    aria-label={`Select ${campground.facilityName}`}
                  />
                  <Link
                    to={`/parks/${campground.parkId}/${campground.facilityId}`}
                    className="min-w-0 truncate font-medium hover:underline"
                  >
                    {campground.facilityName}
                  </Link>
                  <SiteTypeIcons types={campground.siteTypes} />
                  <span className="ml-auto shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                    {campground.distanceMiles} mi
                  </span>
                </span>
                <span className="block truncate text-xs text-muted-foreground">{campground.parkName}</span>
              </th>
              {dates.map((iso) => {
                const free = campground.freeByDate[iso];
                return (
                  <td
                    key={iso}
                    // A plain title rather than a tooltip component: there are
                    // thousands of these, and thousands of Radix instances
                    // would cost far more than they are worth here.
                    title={free ? `${describe(iso)} · ${free} site${free === 1 ? "" : "s"} free` : describe(iso)}
                    className={`border-b p-0 ${isWeekend(iso) && !free ? "bg-muted/60" : ""}`}
                  >
                    <span className={`block h-6 w-[13px] ${densityClass(free)}`} />
                    <span className="sr-only">
                      {free ? `${describe(iso)}: ${free} free` : `${describe(iso)}: none`}
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
