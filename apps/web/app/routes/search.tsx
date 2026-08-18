import { useEffect, useState } from "react";
import { Form, Link, useLocation, useNavigation } from "react-router";

import { Button } from "@campingmeow/ui/components/button";
import { Checkbox } from "@campingmeow/ui/components/checkbox";
import { Input } from "@campingmeow/ui/components/input";
import { RadioGroup, RadioGroupItem } from "@campingmeow/ui/components/radio-group";
import { toast } from "@campingmeow/ui/components/toast";
import type { Route } from "./+types/search";
import { ValidationError } from "~/lib/errors";
import { parseSearchParams } from "~/lib/search-params";
import { availabilityService, type SearchProgressEvent, type SearchResults } from "~/services/availability.service.server";
import { catalogService } from "~/services/catalog.service.server";

const DAYS = [
  { value: 0, label: "Sun" },
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
];

export async function loader({ request }: Route.LoaderArgs) {
  const { facilityIds, hasQuery, criteria } = parseSearchParams(request);
  if (facilityIds.length === 0) throw new Response("Not Found", { status: 404 });

  const facilities = await catalogService.listFacilityPicker({ facilityIds });
  if (facilities.length === 0) throw new Response("Not Found", { status: 404 });

  // No search run yet — just show the form.
  if (!hasQuery) {
    return { facilities, results: null, criteria, fields: undefined };
  }

  try {
    // Stored data only, so this returns immediately. Anything stale is
    // re-scanned by /api/search-progress and streamed back in below.
    const results = await availabilityService.searchOpenings({
      facilityIds,
      checkinDays: criteria.checkinDays,
      nights: criteria.nights,
      startDate: criteria.startDate,
      endDate: criteria.endDate,
    });
    return { facilities, results, criteria, fields: undefined };
  } catch (err) {
    if (err instanceof ValidationError) {
      return { facilities, results: null, criteria, fields: err.fields };
    }
    throw err;
  }
}

export default function Search({ loaderData }: Route.ComponentProps) {
  const { facilities, results, criteria, fields } = loaderData;
  const navigation = useNavigation();
  const searching = navigation.state === "loading";
  const [bounds, setBounds] = useState<"anytime" | "range">(criteria.bounds);
  const facilityIds = facilities.map((f) => f.id).join(",");
  const watchHref = `/watches/new?facilities=${facilityIds}`;

  const { live, progress } = useLiveRefresh(results);

  return (
    <div>
      <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
        ← Parks
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Check availability</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        Searching {facilities.length} campground{facilities.length === 1 ? "" : "s"}. We answer from what we already know, then
        check ReserveCalifornia for anything older than five minutes and update the results as they come in. Openings move fast —
        set a watch to be emailed the moment one appears.
      </p>

      <Form method="get" className="mt-8 max-w-2xl space-y-6">
        <input type="hidden" name="facilities" value={facilityIds} />

        <fieldset>
          <legend className="text-sm font-medium">Check-in days</legend>
          <div className="mt-2 flex flex-wrap gap-4">
            {DAYS.map((day) => (
              <div key={day.value} className="flex items-center gap-1.5">
                <Checkbox
                  id={`day-${day.value}`}
                  name="days"
                  value={String(day.value)}
                  defaultChecked={criteria.checkinDays.includes(day.value)}
                  aria-label={day.label}
                />
                <label htmlFor={`day-${day.value}`} className="text-sm">
                  {day.label}
                </label>
              </div>
            ))}
          </div>
          {fields?.checkinDays && <p className="mt-1 text-sm text-destructive">{fields.checkinDays}</p>}
        </fieldset>

        <div>
          <label htmlFor="nights" className="text-sm font-medium">
            Nights
          </label>
          <Input id="nights" name="nights" type="number" min={1} max={7} defaultValue={criteria.nights} className="mt-2 w-24" />
          {fields?.nights && <p className="mt-1 text-sm text-destructive">{fields.nights}</p>}
        </div>

        <fieldset>
          <legend className="text-sm font-medium">When</legend>
          <RadioGroup name="bounds" value={bounds} onValueChange={(v) => setBounds(v as "anytime" | "range")} className="mt-2">
            <div className="flex items-center gap-2">
              <RadioGroupItem value="anytime" id="bounds-anytime" />
              <label htmlFor="bounds-anytime" className="text-sm">
                Anytime in the booking window{" "}
                <span className="text-xs text-muted-foreground">(the full ~6 months ReserveCalifornia has open)</span>
              </label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="range" id="bounds-range" />
              <label htmlFor="bounds-range" className="text-sm">
                Only between specific dates
              </label>
            </div>
          </RadioGroup>
          {bounds === "range" && (
            <div className="mt-3 flex gap-4">
              <div>
                <label htmlFor="from" className="text-sm font-medium">
                  Earliest check-in
                </label>
                <Input id="from" name="from" type="date" defaultValue={criteria.startDate ?? ""} className="mt-2" />
                {fields?.startDate && <p className="mt-1 text-sm text-destructive">{fields.startDate}</p>}
              </div>
              <div>
                <label htmlFor="to" className="text-sm font-medium">
                  Latest check-in
                </label>
                <Input id="to" name="to" type="date" defaultValue={criteria.endDate ?? ""} className="mt-2" />
                {fields?.endDate && <p className="mt-1 text-sm text-destructive">{fields.endDate}</p>}
              </div>
            </div>
          )}
        </fieldset>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={searching}>
            {searching ? "Searching…" : "Check availability"}
          </Button>
          <Button variant="outline" asChild>
            <Link to={watchHref}>Watch these instead</Link>
          </Button>
        </div>
      </Form>

      {live && (
        <div className="mt-10 max-w-3xl">
          <p className="text-sm text-muted-foreground">
            {live.totalOpenings} matching check-in date{live.totalOpenings === 1 ? "" : "s"} between {live.windowStart} and{" "}
            {live.windowEnd}.
          </p>

          {progress && (
            <div className="mt-3" role="status" aria-live="polite">
              <div className="h-2 w-full overflow-hidden rounded-full bg-accent">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }}
                />
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                Checking ReserveCalifornia for live availability — {progress.done} of {progress.total} campground
                {progress.total === 1 ? "" : "s"}
                {progress.facilityName ? ` · just did ${progress.facilityName}` : ""}
              </p>
            </div>
          )}

          {live.stale.length > 0 && (
            <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
              We couldn&apos;t reach ReserveCalifornia for {live.stale.join(", ")}, so{" "}
              {live.stale.length === 1 ? "it is" : "they are"} showing the last data we stored.
            </div>
          )}

          {live.unscanned.length > 0 && (
            <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
              We haven&apos;t scanned {live.unscanned.join(", ")} yet, so there&apos;s nothing to search. Create a watch and
              we&apos;ll start tracking {live.unscanned.length === 1 ? "it" : "them"} right away.
            </div>
          )}

          <div className="mt-4 space-y-6">
            {live.results.map((facility) => (
              <div key={facility.facilityId}>
                <h2 className="text-sm font-medium">
                  {facility.parkName} · {facility.facilityName}
                  <span className="ml-2 font-normal text-muted-foreground">
                    {facility.isStale
                      ? "checking now…"
                      : facility.lastScannedAt
                        ? `checked ${timeAgo(facility.lastScannedAt)}`
                        : "not scanned yet"}
                  </span>
                </h2>
                {facility.openings.length === 0 ? (
                  <p className="mt-2 text-sm text-muted-foreground">
                    {facility.isStale
                      ? "Checking ReserveCalifornia…"
                      : facility.lastScannedAt
                        ? "Nothing open for this pattern right now."
                        : "No data yet — a watch will start the first scan."}
                  </p>
                ) : (
                  <ul className="mt-2 divide-y rounded-lg border">
                    {facility.openings.map((opening) => (
                      <li key={opening.checkin} className="flex flex-col gap-1 p-3 text-sm sm:flex-row sm:items-baseline sm:gap-3">
                        <span className="font-medium tabular-nums">
                          {opening.dayLabel} {opening.checkin}
                        </span>
                        <span className="text-muted-foreground">
                          {opening.siteNames.length} site{opening.siteNames.length === 1 ? "" : "s"}:{" "}
                          {opening.siteNames.slice(0, 4).join(", ")}
                          {opening.siteNames.length > 4 ? `, +${opening.siteNames.length - 4} more` : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>

          <div className="mt-8 rounded-lg border p-4">
            <p className="text-sm">
              Book on{" "}
              <a href="https://www.reservecalifornia.com/" target="_blank" rel="noreferrer" className="underline underline-offset-2">
                reservecalifornia.com
              </a>
              , or let us watch these campgrounds and email you when something opens.
            </p>
            <Button className="mt-3" asChild>
              <Link to={watchHref}>Create a watch</Link>
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

interface RefreshProgress {
  done: number;
  total: number;
  facilityName: string;
}

/**
 * Subscribe to the refresh happening behind this search. The loader's results
 * render first; each SSE frame carries a complete replacement snapshot, so the
 * page swaps state in rather than merging anything itself.
 */
function useLiveRefresh(initial: SearchResults | null) {
  const location = useLocation();
  const [live, setLive] = useState(initial);
  const [progress, setProgress] = useState<RefreshProgress | null>(null);

  useEffect(() => {
    setLive(initial);

    if (!initial || initial.staleCount === 0) {
      setProgress(null);
      return;
    }
    setProgress({ done: 0, total: initial.staleCount, facilityName: "" });

    const source = new EventSource(`/api/search-progress${location.search}`);

    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as SearchProgressEvent;
      if (event.type === "progress") {
        setLive(event.results);
        setProgress({ done: event.done, total: event.total, facilityName: event.facilityName });
        return;
      }
      if (event.type === "error") toast({ title: event.message, variant: "destructive" });
      setProgress(null);
      source.close();
    };

    // Fires on a dropped connection too; EventSource would otherwise reconnect
    // and start the whole refresh over.
    source.onerror = () => {
      setProgress(null);
      source.close();
    };

    return () => source.close();
  }, [initial, location.search]);

  return { live, progress };
}

function timeAgo(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export { PageErrorBoundary as ErrorBoundary } from "~/components/page-error-boundary";
