import { useEffect } from "react";
import { useFetcher, useRevalidator } from "react-router";

import { Button } from "@campingmeow/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@campingmeow/ui/components/card";
import type { Route } from "./+types/admin";
import { ForbiddenError } from "~/lib/errors";
import { withAuth } from "~/lib/with-auth";
import type { AuthUser } from "~/services/auth.service.server";
import { adminService } from "~/services/admin.service.server";
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
  const scanner = dashboard.scanner;
  const notifier = dashboard.notifier;

  // The scanner never stops, so keep the numbers moving while this page is open.
  const revalidator = useRevalidator();
  useEffect(() => {
    const id = setInterval(() => revalidator.revalidate(), 10_000);
    return () => clearInterval(id);
  }, [revalidator]);

  const stats = [
    { label: "Users", value: dashboard.stats.userCount },
    { label: "Parks", value: dashboard.stats.parkCount },
    { label: "Campgrounds", value: dashboard.stats.facilityCount },
    { label: "Active watches", value: dashboard.stats.watchCount },
    { label: "Watched campgrounds", value: dashboard.stats.watchedFacilityCount },
    { label: "Requests queued", value: dashboard.queueDepth },
    { label: "Scanned / hr", value: scanner.scannedLastHour },
    { label: "Emails today", value: notifier.emailsSentToday },
  ];

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Admin</h1>

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-8">
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
            <CardTitle>Scanner</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-3 text-sm text-muted-foreground">
              Runs continuously, always scanning whichever campground is most overdue — watched ones first (target: under an hour
              old), then the rest of the catalog (under a day). Every request queues at a global one-per-second gate.
            </p>

            {dashboard.rateLimit.blocked && (
              <div className="mb-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
                ReserveCalifornia has rate-limited us. Scanning is paused until{" "}
                {new Date(dashboard.rateLimit.until!).toLocaleTimeString()}.
              </div>
            )}

            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-muted-foreground">Status</dt>
                <dd className="font-medium">
                  {!scanner.running ? "Stopped" : scanner.current ? `Scanning ${scanner.current}` : "Idle — nothing overdue"}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Overdue</dt>
                <dd className="font-medium tabular-nums">
                  {scanner.watchedOverdue} watched · {scanner.catalogOverdue} catalog
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Oldest watched scan</dt>
                <dd className="font-medium">{scanner.oldestWatchedScan ? timeAgo(scanner.oldestWatchedScan) : "never"}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Oldest catalog scan</dt>
                <dd className="font-medium">{scanner.oldestCatalogScan ? timeAgo(scanner.oldestCatalogScan) : "never"}</dd>
              </div>
            </dl>

            <p className="mt-3 text-xs text-muted-foreground">
              A rising overdue count or an oldest scan past its target means we are not keeping up.
            </p>

            <dl className="mt-4 grid grid-cols-2 gap-3 border-t pt-4 text-sm">
              <div>
                <dt className="text-muted-foreground">Notifier</dt>
                <dd className="font-medium">{notifier.running ? "Running (every 10 min)" : "Stopped"}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Email via</dt>
                <dd className="font-medium">{notifier.sender}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Openings awaiting email</dt>
                <dd className="font-medium tabular-nums">{notifier.pendingEvents}</dd>
              </div>
            </dl>

            {notifier.sender.startsWith("stub") && (
              <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
                No email provider configured — openings are matched but nothing is sent. Set <code>RESEND_API_KEY</code>.
              </div>
            )}
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

function timeAgo(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export { PageErrorBoundary as ErrorBoundary } from "~/components/page-error-boundary";
