import { useEffect, useState } from "react";
import { useFetcher, useRevalidator } from "react-router";

import { Alert, AlertTitle } from "@campingmeow/ui/components/alert";
import { Button } from "@campingmeow/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@campingmeow/ui/components/card";
import { Separator } from "@campingmeow/ui/components/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@campingmeow/ui/components/table";
import type { Route } from "./+types/admin";
import { ForbiddenError } from "~/lib/errors";
import { timeAgo } from "~/lib/time";
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
  const recheck = useFetcher<{ checked: number; nowBookable: string[] }>();
  const pause = useFetcher<{ paused: boolean }>();
  const ban = useFetcher<{ banned?: boolean; error?: string }>();
  // Watches are useful when answering "why did I not get an email", and noise
  // the rest of the time, so they open on demand.
  const [expanded, setExpanded] = useState<string | null>(null);
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
    { label: "Cycle (min)", value: scanner.lastCycleDurationMs === null ? "—" : Math.round(scanner.lastCycleDurationMs / 60000) },
    { label: "Emails (24h)", value: `${notifier.quota.sentLast24h}/${notifier.quota.limit}` },
  ];

  return (
    <div>
      <h1 className="text-4xl font-semibold">Admin</h1>

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-8">
        {stats.map((stat) => (
          <Card key={stat.label}>
            <CardContent className="p-4">
              <div className="font-mono text-2xl font-semibold tabular-nums">{stat.value}</div>
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
              Runs continuously over every bookable campground across a 63-day window, always taking the most overdue. A full
              cycle is ~17 minutes. Campgrounds with no inventory or first-come-first-served sites are never scanned — nothing
              there can open up. Every request queues at a global one-per-second gate.
            </p>

            {dashboard.rateLimit.blocked && (
              <Alert variant="destructive" className="mb-3">
                <AlertTitle>Blocked by ReserveCalifornia</AlertTitle>
                Scanning <strong>and email</strong> are stopped until {new Date(dashboard.rateLimit.until!).toLocaleTimeString()}.
                {notifier.pendingEvents > 0 && ` ${notifier.pendingEvents} openings are waiting to be sent.`} This is an incident,
                not a hiccup — a 429 means we exceeded their rate limit and the block can last hours.
              </Alert>
            )}

            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-muted-foreground">Status</dt>
                <dd className="font-medium">
                  {!scanner.running
                    ? "Stopped"
                    : scanner.paused
                      ? "Paused"
                      : scanner.current
                        ? "Scanning"
                        : "Between cycles"}
                </dd>
                {scanner.current && (
                  // Campground names repeat across the state ("Group Camp",
                  // "Upper Loop"), so the park is what makes this locatable.
                  <dd className="text-xs text-muted-foreground">
                    {scanner.currentPark} — {scanner.current}
                  </dd>
                )}
              </div>
              <div>
                <dt className="text-muted-foreground">This cycle</dt>
                <dd className="font-medium tabular-nums">
                  {scanner.progressTotal === 0
                    ? "—"
                    : `${Math.round((scanner.progress / scanner.progressTotal) * 100)}% · ${scanner.progress}/${scanner.progressTotal}${
                        scanner.paused ? " · held" : ""
                      }`}
                </dd>
                {scanner.progressTotal > 0 && (
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-poppy transition-[width] duration-500"
                      style={{ width: `${(scanner.progress / scanner.progressTotal) * 100}%` }}
                    />
                  </div>
                )}
              </div>
              <div>
                <dt className="text-muted-foreground">Last cycle</dt>
                <dd className="font-medium tabular-nums">
                  {scanner.lastCycleDurationMs === null
                    ? "in progress"
                    : `${Math.round(scanner.lastCycleDurationMs / 60000)} min · ${scanner.lastCycleScanned} scanned${
                        scanner.lastCycleFailed > 0 ? ` · ${scanner.lastCycleFailed} failed` : ""
                      }`}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Cycles completed</dt>
                <dd className="font-medium tabular-nums">{scanner.cycleNumber}</dd>
              </div>
              <div className="col-span-2">
                <dt className="text-muted-foreground">Catalog</dt>
                <dd className="font-medium tabular-nums">
                  {scanner.byStatus.bookable ?? 0} bookable · {scanner.byStatus.no_inventory ?? 0} no inventory ·{" "}
                  {scanner.byStatus.first_come_first_served ?? 0} first-come
                </dd>
              </div>
            </dl>

            <p className="mt-3 text-xs text-muted-foreground">
              A cycle that keeps growing means we are falling behind — every campground is scanned every pass, so the duration is
              the whole story.
            </p>

            <pause.Form method="post" action="/api/scanner-pause" className="mt-3">
              <input type="hidden" name="paused" value={String(!scanner.paused)} />
              <Button type="submit" variant="outline" size="sm" disabled={pause.state !== "idle" || !scanner.running}>
                {scanner.paused ? "Resume scanning" : "Pause scanning"}
              </Button>
              {scanner.paused && (
                <span className="ml-2 text-xs text-muted-foreground">
                  Sweeping is stopped. Stored availability is still served, and goes stale until you resume.
                </span>
              )}
            </pause.Form>

            <recheck.Form method="post" action="/api/recheck-facilities" className="mt-3">
              <Button type="submit" variant="outline" size="sm" disabled={recheck.state !== "idle"}>
                {recheck.state !== "idle" ? "Re-checking…" : "Re-check non-bookable campgrounds"}
              </Button>
            </recheck.Form>
            {recheck.data && (
              <p className="mt-2 text-xs text-muted-foreground">
                Checked {recheck.data.checked}.{" "}
                {recheck.data.nowBookable.length === 0
                  ? "None have inventory yet."
                  : `Now bookable: ${recheck.data.nowBookable.join(", ")}.`}
              </p>
            )}

            <Separator className="mt-4" />
            <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-muted-foreground">Notifier</dt>
                <dd className="font-medium">Runs after each scan cycle</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Email via</dt>
                <dd className="font-medium">{notifier.sender}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Openings awaiting email</dt>
                <dd className="font-medium tabular-nums">{notifier.pendingEvents}</dd>
              </div>
              <div>
                {/* Trailing 24h, not since midnight: Resend's free quota
                    resets 24 hours after each send, not at a fixed hour. */}
                <dt className="text-muted-foreground">Emails sent (rolling 24h)</dt>
                <dd className="font-medium tabular-nums">
                  {notifier.quota.sentLast24h} / {notifier.quota.limit}
                  <span className="ml-2 font-normal text-muted-foreground">{notifier.quota.remaining} left</span>
                </dd>
              </div>
            </dl>

            {notifier.quota.paused && (
              <Alert variant="warning" className="mt-3">
                <AlertTitle>Notifications paused — daily email limit reached</AlertTitle>
                Openings are still being found and stored; they are held unsent and go out when the allowance returns
                {notifier.quota.resumesAt ? ` (around ${new Date(notifier.quota.resumesAt).toLocaleString()})` : ""}. Raising
                the Resend plan lifts the cap.
              </Alert>
            )}

            {notifier.sender.startsWith("stub") && (
              <Alert variant="warning" className="mt-3">
                No email provider configured — openings are matched but nothing is sent. Set <code>RESEND_API_KEY</code>.
              </Alert>
            )}
          </CardContent>
        </Card>
      </div>

      <h2 className="mt-8 text-sm font-medium">Users</h2>
      <Table className="mt-3">
        <TableHeader>
          <TableRow>
            <TableHead>Email</TableHead>
            <TableHead>Name</TableHead>
            <TableHead>Watches</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Sent 24h / 7d</TableHead>
            <TableHead>Last email</TableHead>
            <TableHead>Joined</TableHead>
            <TableHead className="text-right">Access</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {dashboard.users.map((user) => (
            <TableRow key={user.id} className={user.banned ? "opacity-60" : undefined}>
              <TableCell>
                {user.email}
                {user.banned && <span className="ml-2 text-xs font-medium text-destructive">Banned</span>}
              </TableCell>
              <TableCell>{user.name}</TableCell>
              <TableCell className="tabular-nums">
                {user.watchCount > 0 ? (
                  <button
                    type="button"
                    onClick={() => setExpanded(expanded === user.id ? null : user.id)}
                    className="underline underline-offset-2 hover:text-foreground"
                    aria-expanded={expanded === user.id}
                  >
                    {user.watchCount}
                  </button>
                ) : (
                  0
                )}
              </TableCell>
              <TableCell>
                {user.emailNotifications ? (
                  <span className="text-muted-foreground">on</span>
                ) : (
                  <span className="font-medium text-destructive">off</span>
                )}
              </TableCell>
              <TableCell className="tabular-nums">
                {user.emailsLast24h} / {user.emailsLast7d}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {user.lastEmailedAt ? timeAgo(user.lastEmailedAt) : "never"}
              </TableCell>
              <TableCell className="tabular-nums">{user.joined}</TableCell>
              <TableCell className="text-right">
                <ban.Form method="post" action="/api/user-ban">
                  <input type="hidden" name="userId" value={user.id} />
                  <input type="hidden" name="banned" value={String(!user.banned)} />
                  <Button
                    type="submit"
                    size="sm"
                    variant={user.banned ? "outline" : "destructive"}
                    disabled={ban.state !== "idle"}
                  >
                    {user.banned ? "Unban" : "Ban"}
                  </Button>
                </ban.Form>
              </TableCell>
            </TableRow>
          ))}
          {dashboard.users
            .filter((user) => user.id === expanded)
            .map((user) => (
              <TableRow key={`${user.id}-watches`}>
                <TableCell colSpan={8} className="bg-muted/40">
                  <ul className="space-y-2 text-xs">
                    {user.watches.map((watch) => (
                      <li key={watch.id}>
                        <span className="font-medium">{watch.pattern}</span>
                        <span className="text-muted-foreground"> — {watch.campgrounds.join("; ")}</span>
                      </li>
                    ))}
                  </ul>
                </TableCell>
              </TableRow>
            ))}
        </TableBody>
      </Table>

      {ban.data?.error && (
        <Alert variant="destructive" className="mt-3 max-w-2xl">
          {ban.data.error}
        </Alert>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        Banning signs an account out everywhere and stops its email. Nothing is deleted — watches and settings come back if
        the ban is lifted.
      </p>
    </div>
  );
}


export { PageErrorBoundary as ErrorBoundary } from "~/components/page-error-boundary";
