import { useEffect } from "react";
import { Link, isRouteErrorResponse, useRouteError } from "react-router";

import { Button } from "@campingmeow/ui/components/button";
import { toast } from "@campingmeow/ui/components/toast";
import { ErrorLookup } from "~/lib/errors";

/**
 * Page-level error boundary. Export this as `ErrorBoundary` from a route so a
 * failure inside that page keeps the app shell (header, nav) rendered: the
 * user gets a toast plus a recoverable inline message instead of a full-page
 * fault. The root boundary stays as the last resort for shell-level crashes.
 */
export function PageErrorBoundary() {
  const error = useRouteError();
  const status = isRouteErrorResponse(error) ? error.status : 500;
  const { defaultMicroLabel, defaultDescription } = ErrorLookup(status);

  // Bare HTTP status text ("Not Found") tells the user nothing the friendly
  // copy doesn't already say, so only surface genuinely custom messages.
  const GENERIC = ["not found", "forbidden", "unauthorized", "method not allowed", "bad request"];
  const raw =
    isRouteErrorResponse(error) && typeof error.data === "string" && error.data
      ? error.data
      : error instanceof Error
        ? error.message
        : undefined;
  const detail = raw && !GENERIC.includes(raw.trim().toLowerCase()) ? raw : undefined;

  useEffect(() => {
    toast({
      title: defaultMicroLabel,
      description: status === 500 ? defaultDescription : (detail ?? defaultDescription),
      variant: "destructive",
    });
  }, [defaultMicroLabel, defaultDescription, detail, status]);

  return (
    <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-6">
      <h1 className="text-lg font-semibold">{defaultMicroLabel}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{status === 500 ? defaultDescription : (detail ?? defaultDescription)}</p>
      <div className="mt-4 flex gap-2">
        <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
          Try again
        </Button>
        <Button variant="outline" size="sm" asChild>
          <Link to="/">Back to parks</Link>
        </Button>
      </div>
      {/* eslint-disable-next-line turbo/no-undeclared-env-vars */}
      {import.meta.env.DEV && error instanceof Error && error.stack && (
        <pre className="mt-4 max-h-64 overflow-auto font-mono text-xs text-muted-foreground">
          <code>{error.stack}</code>
        </pre>
      )}
    </div>
  );
}
