import { useState } from "react";
import { Form, Link, redirect } from "react-router";

import { Button } from "@campingmeow/ui/components/button";
import { Card } from "@campingmeow/ui/components/card";
import { Checkbox } from "@campingmeow/ui/components/checkbox";
import { Input } from "@campingmeow/ui/components/input";
import { Label } from "@campingmeow/ui/components/label";
import type { Route } from "./+types/watches.new";
import { SiteTypeIcons } from "~/components/site-type-icons";
import { ValidationError } from "~/lib/errors";
import { withAuth } from "~/lib/with-auth";
import type { AuthUser } from "~/services/auth.service.server";
import { catalogService, type FacilityPickerItem } from "~/services/catalog.service.server";
import { watchService } from "~/services/watch.service.server";

const DAYS = [
  { value: 0, label: "Sun" },
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
];

export const loader = withAuth(async ({ request }: Route.LoaderArgs & { user: AuthUser }) => {
  const url = new URL(request.url);
  const facilitiesParam = url.searchParams.get("facilities");
  const preselectedFacilityId = url.searchParams.get("facilityId");

  // Coming from the home-page selection: show exactly those campgrounds,
  // all pre-checked (unchecking here removes them from the watch).
  if (facilitiesParam) {
    const facilityIds = facilitiesParam.split(",").filter(Boolean);
    const facilities = await catalogService.listFacilityPicker({ facilityIds });
    if (facilities.length === 0) throw new Response("Not Found", { status: 404 });
    return { facilities, preselectedIds: facilities.map((f) => f.id) };
  }

  // Coming from a park detail page: full picker with that campground checked.
  if (preselectedFacilityId) {
    const facility = await catalogService.getFacilityDetail(preselectedFacilityId);
    if (!facility) throw new Response("Not Found", { status: 404 });
  }
  const facilities = await catalogService.listFacilityPicker();
  return { facilities, preselectedIds: preselectedFacilityId ? [preselectedFacilityId] : [] };
});

export const action = withAuth(async ({ request, user }: Route.ActionArgs & { user: AuthUser }) => {
  const formData = await request.formData();
  try {
    await watchService.createWatch(user.id, {
      facilityIds: formData.getAll("facilityIds").map(String),
      checkinDays: formData.getAll("checkinDays").map(Number),
      nights: Number(formData.get("nights")),
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      return { fields: err.fields };
    }
    throw err;
  }
  return redirect("/watches");
});

function FacilityPicker({
  facilities,
  preselectedIds,
  error,
}: {
  facilities: FacilityPickerItem[];
  preselectedIds: string[];
  error?: string;
}) {
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? facilities.filter((f) => f.name.toLowerCase().includes(needle) || f.parkName.toLowerCase().includes(needle))
    : facilities;

  return (
    <fieldset>
      <legend className="text-sm font-medium">Campgrounds</legend>
      <p className="mt-1 text-xs text-muted-foreground">Pick one or more. We watch all of them for this pattern.</p>
      <Input
        type="search"
        placeholder="Filter by park or campground…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        className="mt-2 max-w-sm"
        aria-label="Filter campgrounds"
      />
      <Card className="mt-2 max-h-64 space-y-1 overflow-y-auto p-3">
        {visible.length === 0 ? (
          <p className="text-sm text-muted-foreground">No campgrounds match.</p>
        ) : (
          visible.map((facility) => (
            <div key={facility.id} className="flex items-start gap-2">
              <Checkbox
                id={`pick-${facility.id}`}
                name="facilityIds"
                value={facility.id}
                defaultChecked={facility.watchable && preselectedIds.includes(facility.id)}
                disabled={!facility.watchable}
                aria-label={`${facility.parkName} · ${facility.name}`}
                className="mt-0.5"
              />
              <Label htmlFor={`pick-${facility.id}`} className={facility.watchable ? undefined : "opacity-60"}>
                <span className="text-muted-foreground">{facility.parkName} · </span>
                {facility.name}
                <SiteTypeIcons types={facility.siteTypes} className="ml-1.5 align-text-bottom" />
                {/* Shown rather than hidden: "first-come, first-served" is
                    genuinely useful to know about a place you might otherwise
                    drive to expecting a reservation. */}
                {!facility.watchable && (
                  <span className="block text-xs font-normal text-muted-foreground">{facility.unwatchableReason}</span>
                )}
              </Label>
            </div>
          ))
        )}
      </Card>
      {error && <p className="mt-1 text-sm text-destructive">{error}</p>}
    </fieldset>
  );
}

export default function NewWatch({ loaderData, actionData }: Route.ComponentProps) {
  const { facilities, preselectedIds } = loaderData;
  const fields = actionData && "fields" in actionData ? actionData.fields : undefined;

  return (
    <div className="max-w-2xl">
      <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
        ← Parks
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">New watch</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Pick campgrounds and the stay pattern you care about. We&apos;ll email you when a matching site opens.
      </p>

      <Form method="post" className="mt-8 space-y-6">
        <FacilityPicker facilities={facilities} preselectedIds={preselectedIds} error={fields?.facilityIds} />

        <fieldset>
          <legend className="text-sm font-medium">Check-in days</legend>
          <div className="mt-2 flex flex-wrap gap-4">
            {DAYS.map((day) => (
              <div key={day.value} className="flex items-center gap-1.5">
                <Checkbox
                  id={`day-${day.value}`}
                  name="checkinDays"
                  value={String(day.value)}
                  defaultChecked={day.value === 5 || day.value === 6}
                  aria-label={day.label}
                />
                <Label htmlFor={`day-${day.value}`}>{day.label}</Label>
              </div>
            ))}
          </div>
          {fields?.checkinDays && <p className="mt-1 text-sm text-destructive">{fields.checkinDays}</p>}
        </fieldset>

        <div>
          <Label htmlFor="nights">Nights</Label>
          <Input id="nights" name="nights" type="number" min={1} max={7} defaultValue={1} className="mt-2 w-24" />
          {fields?.nights && <p className="mt-1 text-sm text-destructive">{fields.nights}</p>}
        </div>

        <p className="text-sm text-muted-foreground">
          A watch covers the next nine weeks and rolls forward each day, so there&apos;s no end date to maintain and nothing to
          renew. For dates further out, browse ReserveCalifornia directly.
        </p>

        <Button type="submit">Create watch</Button>
      </Form>
    </div>
  );
}

export { PageErrorBoundary as ErrorBoundary } from "~/components/page-error-boundary";
