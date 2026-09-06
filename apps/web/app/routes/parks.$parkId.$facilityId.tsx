import { Link } from "react-router";

import { Button } from "@campingmeow/ui/components/button";
import type { Route } from "./+types/parks.$parkId.$facilityId";
import { AvailabilityCalendar } from "~/components/availability-calendar";
import { availabilityService } from "~/services/availability.service.server";

export async function loader({ params }: Route.LoaderArgs) {
  const calendar = await availabilityService.getFacilityCalendar(params.facilityId);
  if (!calendar) throw new Response("Not Found", { status: 404 });
  return { calendar, parkId: params.parkId };
}

export function meta({ data }: Route.MetaArgs) {
  if (!data) return [{ title: "Campground — CampingMeow" }];
  return [{ title: `${data.calendar.facilityName} availability — CampingMeow` }];
}

export default function CampgroundDetail({ loaderData }: Route.ComponentProps) {
  const { calendar, parkId } = loaderData;

  return (
    <div>
      <Link to={`/parks/${parkId}`} className="text-sm text-muted-foreground hover:text-foreground">
        ← {calendar.parkName}
      </Link>

      <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-4xl font-semibold">{calendar.facilityName}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{calendar.parkName}</p>
        </div>
        <Button asChild>
          <Link to={`/watches/new?facilityId=${calendar.facilityId}`}>Watch</Link>
        </Button>
      </div>

      <div className="mt-8">
        <AvailabilityCalendar
          freeDates={calendar.freeDates}
          lastScannedAt={calendar.lastScannedAt}
          windowStart={calendar.windowStart}
          windowEnd={calendar.windowEnd}
          legend="At least one site free that night"
        />

        {/* We only hold 63 days. ReserveCalifornia browses the full six months
            better than we would, so we point at it rather than half-build it. */}
        <p className="mt-6 text-sm text-muted-foreground">
          Looking further ahead than nine weeks?{" "}
          <a
            href={`https://www.reservecalifornia.com/park/${calendar.rcPlaceId}/${calendar.rcFacilityId}`}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2"
          >
            See the full calendar on ReserveCalifornia
          </a>
          .
        </p>
      </div>
    </div>
  );
}

export { PageErrorBoundary as ErrorBoundary } from "~/components/page-error-boundary";
