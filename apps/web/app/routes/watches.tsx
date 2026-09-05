import { Link, useFetcher, useSearchParams } from "react-router";

import { Button } from "@campingmeow/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@campingmeow/ui/components/card";
import { List, ListItem } from "@campingmeow/ui/components/list";
import { Select } from "@campingmeow/ui/components/select";
import type { Route } from "./+types/watches";
import { AvailabilityCalendar } from "~/components/availability-calendar";
import { ForbiddenError } from "~/lib/errors";
import { withAuth } from "~/lib/with-auth";
import { availabilityService } from "~/services/availability.service.server";
import type { AuthUser } from "~/services/auth.service.server";
import { watchService, type WatchListItem } from "~/services/watch.service.server";

export const loader = withAuth(async ({ request, user }: Route.LoaderArgs & { user: AuthUser }) => {
  const watches = await watchService.listWatchesForUser(user.id);

  // One campground at a time. A composite calendar would say "something is
  // free" without saying where — and you need the campground to book it.
  const covered = watches.flatMap((watch) =>
    watch.facilities.map((f) => ({ ...f, checkinDays: watch.checkinDays, nights: watch.nights })),
  );
  const requested = new URL(request.url).searchParams.get("facility");
  const selected = covered.find((f) => f.facilityId === requested) ?? covered[0];

  const calendar = selected
    ? await availabilityService.getWatchCalendar(selected.facilityId, selected.checkinDays, selected.nights)
    : null;

  return {
    watches,
    calendar,
    options: covered.map((f) => ({ id: f.facilityId, label: `${f.parkName} · ${f.facilityName}` })),
    selectedFacilityId: selected?.facilityId ?? "",
  };
});

export const action = withAuth(async ({ request, user }: Route.ActionArgs & { user: AuthUser }) => {
  const formData = await request.formData();
  if (formData.get("intent") === "delete") {
    const watchId = String(formData.get("watchId") ?? "");
    try {
      const deleted = await watchService.deleteWatch(user.id, watchId);
      if (!deleted) throw new Response("Not Found", { status: 404 });
    } catch (err) {
      if (err instanceof ForbiddenError) {
        throw new Response(err.message, { status: 403 });
      }
      throw err;
    }
  }
  return { ok: true };
});

function WatchRow({ watch }: { watch: WatchListItem }) {
  const fetcher = useFetcher();
  const deleting = fetcher.state !== "idle";

  return (
    <ListItem
      className={`flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between ${deleting ? "opacity-50" : ""}`}
    >
      <div>
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {watch.facilities.map((f) => (
            <span key={f.facilityId}>
              <Link to={`/parks/${f.parkId}`} className="font-medium hover:underline">
                {f.parkName}
              </Link>
              <span className="text-muted-foreground"> · {f.facilityName}</span>
            </span>
          ))}
        </div>
        <div className="mt-1 text-muted-foreground">
          Check-in {watch.dayLabels.join(", ")} · {watch.nights} night{watch.nights === 1 ? "" : "s"} · anytime in the booking
          window
        </div>
      </div>
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="delete" />
        <input type="hidden" name="watchId" value={watch.id} />
        <Button type="submit" variant="outline" size="sm" disabled={deleting}>
          Delete
        </Button>
      </fetcher.Form>
    </ListItem>
  );
}

export default function Watches({ loaderData }: Route.ComponentProps) {
  const { watches, calendar, options, selectedFacilityId } = loaderData;
  const [searchParams, setSearchParams] = useSearchParams();

  return (
    <div>
      <h1 className="text-4xl font-semibold">My watches</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        We scan ReserveCalifornia for these patterns and email you when something opens up.
      </p>

      {watches.length === 0 ? (
        <p className="mt-8 text-sm text-muted-foreground">
          No watches yet. <Link to="/parks" className="underline underline-offset-2">Browse parks</Link> and pick a campground to
          watch.
        </p>
      ) : (
        <>
          <List className="mt-6">
            {watches.map((watch) => (
              <WatchRow key={watch.id} watch={watch} />
            ))}
          </List>

          {calendar && (
            <Card className="mt-8">
              <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <CardTitle>What&apos;s open</CardTitle>
                {options.length > 1 && (
                  <Select
                    aria-label="Campground"
                    className="sm:w-72"
                    value={selectedFacilityId}
                    onChange={(e) => {
                      // A URL param rather than local state, so the chosen
                      // campground survives a reload and can be linked to.
                      searchParams.set("facility", e.target.value);
                      setSearchParams(searchParams);
                    }}
                  >
                    {options.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                )}
              </CardHeader>
              <CardContent>
                <AvailabilityCalendar
                  freeDates={calendar.freeDates}
                  lastScannedAt={calendar.lastScannedAt}
                  windowStart={calendar.windowStart}
                  windowEnd={calendar.windowEnd}
                  legend="A stay matching your watch can start here"
                />
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

export { PageErrorBoundary as ErrorBoundary } from "~/components/page-error-boundary";
