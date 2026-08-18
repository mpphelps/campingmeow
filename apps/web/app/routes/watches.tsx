import { Link, useFetcher } from "react-router";

import { Button } from "@campingmeow/ui/components/button";
import type { Route } from "./+types/watches";
import { ForbiddenError } from "~/lib/errors";
import { withAuth } from "~/lib/with-auth";
import type { AuthUser } from "~/services/auth.service.server";
import { watchService, type WatchListItem } from "~/services/watch.service.server";

export const loader = withAuth(async ({ user }: Route.LoaderArgs & { user: AuthUser }) => {
  const watches = await watchService.listWatchesForUser(user.id);
  return { watches };
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
    <li className={`flex flex-col gap-1 p-3 text-sm sm:flex-row sm:items-baseline sm:justify-between ${deleting ? "opacity-50" : ""}`}>
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
          Check-in {watch.dayLabels.join(", ")} · {watch.nights} night{watch.nights === 1 ? "" : "s"}
          {watch.startDate || watch.endDate ? (
            <>
              {" "}
              · {watch.startDate ?? "any"} → {watch.endDate ?? "any"}
            </>
          ) : null}
        </div>
      </div>
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="delete" />
        <input type="hidden" name="watchId" value={watch.id} />
        <Button type="submit" variant="outline" size="sm" disabled={deleting}>
          Delete
        </Button>
      </fetcher.Form>
    </li>
  );
}

export default function Watches({ loaderData }: Route.ComponentProps) {
  const { watches } = loaderData;

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">My watches</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        We scan ReserveCalifornia for these patterns and email you when something opens up.
      </p>

      {watches.length === 0 ? (
        <p className="mt-8 text-sm text-muted-foreground">
          No watches yet. <Link to="/parks" className="underline underline-offset-2">Browse parks</Link> and pick a campground to
          watch.
        </p>
      ) : (
        <ul className="mt-6 divide-y rounded-lg border">
          {watches.map((watch) => (
            <WatchRow key={watch.id} watch={watch} />
          ))}
        </ul>
      )}
    </div>
  );
}

export { PageErrorBoundary as ErrorBoundary } from "~/components/page-error-boundary";
