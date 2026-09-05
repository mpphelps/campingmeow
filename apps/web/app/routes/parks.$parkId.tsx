import { Link } from "react-router";

import { Button } from "@campingmeow/ui/components/button";
import { List, ListItem } from "@campingmeow/ui/components/list";
import type { Route } from "./+types/parks.$parkId";
import { catalogService } from "~/services/catalog.service.server";

export async function loader({ params }: Route.LoaderArgs) {
  const park = await catalogService.getParkDetail(params.parkId);
  if (!park) {
    throw new Response("Not Found", { status: 404 });
  }
  return { park };
}

export default function ParkDetail({ loaderData }: Route.ComponentProps) {
  const { park } = loaderData;

  return (
    <div>
      <Link to="/parks" className="text-sm text-muted-foreground hover:text-foreground">
        ← All parks
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">{park.name}</h1>
      {park.city && <p className="mt-1 text-sm text-muted-foreground">{park.city}, CA</p>}

      <h2 className="mt-8 text-sm font-medium">Campgrounds</h2>
      {park.facilities.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">No bookable campgrounds in this park.</p>
      ) : (
        <List className="mt-3">
          {park.facilities.map((facility) => (
            <ListItem key={facility.id} className="flex items-center justify-between gap-3 text-sm">
              <Link to={`/parks/${park.id}/${facility.id}`} className="min-w-0 font-medium hover:underline">
                {facility.name}
              </Link>
              <div className="flex shrink-0 gap-2">
                <Button variant="outline" size="sm" asChild>
                  <Link to={`/parks/${park.id}/${facility.id}`}>Availability</Link>
                </Button>
                <Button variant="outline" size="sm" asChild>
                  <Link to={`/watches/new?facilityId=${facility.id}`}>Watch</Link>
                </Button>
              </div>
            </ListItem>
          ))}
        </List>
      )}
    </div>
  );
}

export { PageErrorBoundary as ErrorBoundary } from "~/components/page-error-boundary";
