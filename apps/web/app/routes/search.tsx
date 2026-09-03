import { useState } from "react";
import { Form, Link, useNavigation } from "react-router";

import { Alert } from "@campingmeow/ui/components/alert";
import { Button } from "@campingmeow/ui/components/button";
import { Checkbox } from "@campingmeow/ui/components/checkbox";
import { Input } from "@campingmeow/ui/components/input";
import { Label } from "@campingmeow/ui/components/label";
import { List, ListItem } from "@campingmeow/ui/components/list";
import { RadioGroup, RadioGroupItem } from "@campingmeow/ui/components/radio-group";
import type { Route } from "./+types/search";
import { ValidationError } from "~/lib/errors";
import { parseSearchParams } from "~/lib/search-params";
import { availabilityService } from "~/services/availability.service.server";
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
    // Stored data only — no ReserveCalifornia call, so this returns in
    // milliseconds no matter how many people are searching.
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

  return (
    <div>
      <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
        ← Parks
      </Link>
      <h1 className="mt-2 text-4xl font-semibold">Check availability</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        Searching {facilities.length} campground{facilities.length === 1 ? "" : "s"} from our own records, refreshed by a nightly
        sweep of every park. Openings move fast and this is a snapshot, not live — set a watch and we&apos;ll email you the moment
        one appears.
      </p>

      {fields?.facilityIds && (
        <Alert variant="destructive" className="mt-4 max-w-2xl">
          {fields.facilityIds}{" "}
          <Link to="/" className="underline underline-offset-2">
            Change your selection
          </Link>
          , or{" "}
          <Link to={watchHref} className="underline underline-offset-2">
            watch them all instead
          </Link>
          .
        </Alert>
      )}

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
                <Label htmlFor={`day-${day.value}`}>{day.label}</Label>
              </div>
            ))}
          </div>
          {fields?.checkinDays && <p className="mt-1 text-sm text-destructive">{fields.checkinDays}</p>}
        </fieldset>

        <div>
          <Label htmlFor="nights">
            Nights
          </Label>
          <Input id="nights" name="nights" type="number" min={1} max={7} defaultValue={criteria.nights} className="mt-2 w-24" />
          {fields?.nights && <p className="mt-1 text-sm text-destructive">{fields.nights}</p>}
        </div>

        <fieldset>
          <legend className="text-sm font-medium">When</legend>
          <RadioGroup name="bounds" value={bounds} onValueChange={(v) => setBounds(v as "anytime" | "range")} className="mt-2">
            <div className="flex items-center gap-2">
              <RadioGroupItem value="anytime" id="bounds-anytime" />
              <Label htmlFor="bounds-anytime">
                Anytime in the booking window{" "}
                <span className="text-xs text-muted-foreground">(the full ~6 months ReserveCalifornia has open)</span>
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="range" id="bounds-range" />
              <Label htmlFor="bounds-range">
                Only between specific dates
              </Label>
            </div>
          </RadioGroup>
          {bounds === "range" && (
            <div className="mt-3 flex gap-4">
              <div>
                <Label htmlFor="from">
                  Earliest check-in
                </Label>
                <Input id="from" name="from" type="date" defaultValue={criteria.startDate ?? ""} className="mt-2" />
                {fields?.startDate && <p className="mt-1 text-sm text-destructive">{fields.startDate}</p>}
              </div>
              <div>
                <Label htmlFor="to">
                  Latest check-in
                </Label>
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

      {results && (
        <div className="mt-10 max-w-3xl">
          <p className="text-sm text-muted-foreground">
            {results.totalOpenings} matching check-in date{results.totalOpenings === 1 ? "" : "s"} between {results.windowStart} and{" "}
            {results.windowEnd}.
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {results.oldestScannedAt ? (
              <>
                Last updated <strong className="font-medium text-foreground">{timeAgo(results.oldestScannedAt)}</strong>. Sites can
                be taken since then — book on ReserveCalifornia to be sure.
              </>
            ) : (
              "We haven't scanned these campgrounds yet."
            )}
          </p>

          {results.unscanned.length > 0 && (
            <Alert variant="warning" className="mt-3">
              We haven&apos;t scanned {results.unscanned.join(", ")} yet, so there&apos;s nothing to search. Create a watch and
              we&apos;ll start tracking {results.unscanned.length === 1 ? "it" : "them"} right away.
            </Alert>
          )}

          <div className="mt-4 space-y-6">
            {results.results.map((facility) => (
              <div key={facility.facilityId}>
                <h2 className="text-base font-medium">
                  {facility.parkName} · {facility.facilityName}
                  <span className="ml-2 font-normal text-muted-foreground">
                    {facility.lastScannedAt ? `updated ${timeAgo(facility.lastScannedAt)}` : "not scanned yet"}
                  </span>
                </h2>
                {facility.openings.length === 0 ? (
                  <p className="mt-2 text-sm text-muted-foreground">
                    {facility.lastScannedAt
                      ? "Nothing open for this pattern as of the last sweep."
                      : "No data yet — a watch will start the first scan."}
                  </p>
                ) : (
                  <List className="mt-2">
                    {facility.openings.map((opening) => (
                      <ListItem key={opening.checkin} className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-3">
                        <span className="font-mono font-medium text-poppy tabular-nums">
                          {opening.dayLabel} {opening.checkin}
                        </span>
                        <span className="text-muted-foreground">
                          {opening.siteNames.length} site{opening.siteNames.length === 1 ? "" : "s"}:{" "}
                          {opening.siteNames.slice(0, 4).join(", ")}
                          {opening.siteNames.length > 4 ? `, +${opening.siteNames.length - 4} more` : ""}
                        </span>
                      </ListItem>
                    ))}
                  </List>
                )}
              </div>
            ))}
          </div>

          <Alert className="mt-8 p-4">
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
          </Alert>
        </div>
      )}
    </div>
  );
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
