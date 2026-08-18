import { useEffect } from "react";
import { useFetcher, useRevalidator } from "react-router";

import { Button } from "@campingmeow/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@campingmeow/ui/components/card";
import type { Route } from "./+types/admin";
import { ForbiddenError } from "~/lib/errors";
import { withAuth } from "~/lib/with-auth";
import type { AuthUser } from "~/services/auth.service.server";
import { adminService } from "~/services/admin.service.server";
import type { SweepState } from "~/services/availability.service.server";
import type { CatalogSyncResult } from "~/services/catalog.service.server";

export const loader = withAuth(async ({ user }: Route.LoaderArgs & { user: AuthUser }) => {
  try {
    const dashboard = await adminService.getDashboard(user);
    return { dashboard };
  } catch (err) {
    if (err instanceof ForbiddenError) {
      throw new Response("Forbidden", { status: 403 });
    }
    throw err;
  }
});

export default function Admin({ loaderData }: Route.ComponentProps) {
  const { dashboard } = loaderData;
  const sync = useFetcher<CatalogSyncResult>();
  const syncing = sync.state !== "idle";
  const sweep = useFetcher<SweepState>();
  // The fetcher's reply is fresher than the loader's copy right after starting.
  const sweepState = sweep.data ?? dashboard.sweep;
  const sweepRunning = sweepState.running || sweep.state !== "idle";

  // A sweep runs in the background, so poll for progress while it does.
  const revalidator = useRevalidator();
  useEffect(() => {
    if (!sweepState.running) return;
    const id = setInterval(() => revalidator.revalidate(), 5000);
    return () => clearInterval(id);
  }, [sweepState.running, revalidator]);

  const stats = [
    { label: "Users", value: dashboard.stats.userCount },
    { label: "Parks", value: dashboard.stats.parkCount },
    { label: "Campgrounds", value: dashboard.stats.facilityCount },
    { label: "Active watches", value: dashboard.stats.watchCount },
    { label: "Watched campgrounds", value: dashboard.stats.watchedFacilityCount },
  ];

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Admin</h1>

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {stats.map((stat) => (
          <Card key={stat.label}>
            <CardContent className="p-4">
              <div className="text-2xl font-semibold tabular-nums">{stat.value}</div>
              <div className="mt-1 text-xs text-muted-foreground">{stat.label}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Catalog sync</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-3 text-sm text-muted-foreground">Refresh the park and campground list from ReserveCalifornia.</p>
            <sync.Form method="post" action="/api/catalog-sync">
              <Button type="submit" disabled={syncing}>
                {syncing ? "Syncing…" : "Sync catalog now"}
              </Button>
            </sync.Form>
            {sync.data && (
              <p className="mt-3 text-sm text-muted-foreground">
                Synced: {sync.data.parksUpserted} parks ({sync.data.parksDeactivated} deactivated), {sync.data.facilitiesUpserted}{" "}
                campgrounds ({sync.data.facilitiesDeactivated} deactivated, {sync.data.facilitiesSkipped} skipped).
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Availability sweep</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-3 text-sm text-muted-foreground">
              Scan campgrounds and store what&apos;s open. We hold to one request every 2.5s to stay under ReserveCalifornia&apos;s
              rate limit, so each campground takes roughly 30 seconds and a full sweep runs for hours. It runs in the background —
              you can leave this page.
            </p>

            {dashboard.rateLimit.blocked && (
              <div className="mb-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
                ReserveCalifornia has rate-limited us. Scanning is paused until{" "}
                {new Date(dashboard.rateLimit.until!).toLocaleTimeString()}.
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <sweep.Form method="post" action="/api/scan-watched">
                <input type="hidden" name="scope" value="watched" />
                <Button type="submit" disabled={sweepRunning}>
                  Scan watched ({dashboard.stats.watchedFacilityCount})
                </Button>
              </sweep.Form>
              <sweep.Form method="post" action="/api/scan-watched">
                <input type="hidden" name="scope" value="all" />
                <Button type="submit" variant="outline" disabled={sweepRunning}>
                  Full sweep — all {dashboard.stats.facilityCount}
                </Button>
              </sweep.Form>
            </div>

            {sweepState.running ? (
              <div className="mt-4">
                <div className="h-2 w-full overflow-hidden rounded-full bg-accent">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{ width: `${sweepState.total ? Math.round((sweepState.done / sweepState.total) * 100) : 0}%` }}
                  />
                </div>
                <div className="mt-2 flex items-center justify-between gap-3">
                  <p className="text-sm text-muted-foreground">
                    {sweepState.scope === "all" ? "Full sweep" : "Watched sweep"}: {sweepState.done} of {sweepState.total}
                    {sweepState.failed > 0 ? ` · ${sweepState.failed} failed` : ""}
                    {sweepState.currentFacility ? ` · last: ${sweepState.currentFacility}` : ""}
                  </p>
                  <sweep.Form method="post" action="/api/scan-watched">
                    <input type="hidden" name="intent" value="cancel" />
                    <Button type="submit" variant="outline" size="sm">
                      Stop sweep
                    </Button>
                  </sweep.Form>
                </div>
              </div>
            ) : sweepState.finishedAt ? (
              <p className="mt-3 text-sm text-muted-foreground">
                {sweepState.cancelled
                  ? "Last sweep stopped by an admin"
                  : sweepState.blockedUntil
                    ? "Last sweep stopped early (rate limited)"
                    : "Last sweep finished"}{" "}
                {new Date(sweepState.finishedAt).toLocaleTimeString()}: {sweepState.done} campground
                {sweepState.done === 1 ? "" : "s"}
                {sweepState.failed > 0 ? `, ${sweepState.failed} failed` : ""}.
              </p>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <h2 className="mt-8 text-sm font-medium">Users</h2>
      <div className="mt-3 overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="p-3 font-medium">Email</th>
              <th className="p-3 font-medium">Name</th>
              <th className="p-3 font-medium">Watches</th>
              <th className="p-3 font-medium">Joined</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {dashboard.users.map((user) => (
              <tr key={user.id}>
                <td className="p-3">{user.email}</td>
                <td className="p-3">{user.name}</td>
                <td className="p-3 tabular-nums">{user.watchCount}</td>
                <td className="p-3 tabular-nums">{user.joined}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export { PageErrorBoundary as ErrorBoundary } from "~/components/page-error-boundary";
