import { ValidationError } from "~/lib/errors";
import { logger } from "~/lib/logger.server";
import { parseSearchParams } from "~/lib/search-params";
import { authService } from "~/services/auth.service.server";
import { availabilityService } from "~/services/availability.service.server";
import type { Route } from "./+types/api.search-progress";

/**
 * Server-sent events for a search in progress.
 *
 * `/search` answers instantly from stored availability; this stream re-scans
 * whatever was stale and pushes a replacement snapshot after each campground,
 * so the page fills in live instead of blocking on a ~7s-per-campground
 * refresh. One `data:` frame per event, each a `SearchProgressEvent`.
 *
 * Signed-in only: each connection spends real ReserveCalifornia requests, and
 * the per-search campground cap bounds one request, not how many a stranger
 * can open at once.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const user = await authService.getAuthenticatedUser(request);
  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { facilityIds, criteria } = parseSearchParams(request);
  if (facilityIds.length === 0) {
    return new Response("Not Found", { status: 404 });
  }

  // Cancelling the stream must also stop the scans behind it: an abandoned tab
  // shouldn't keep calling ReserveCalifornia for nobody. `request.signal`
  // covers a dropped connection; `cancel()` covers the reader going away.
  const aborter = new AbortController();
  const abort = () => aborter.abort();
  request.signal.addEventListener("abort", abort);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (payload: unknown) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          // The client hung up between events; stop producing.
          open = false;
          aborter.abort();
        }
      };

      try {
        for await (const event of availabilityService.refreshSearch(
          {
            facilityIds,
            checkinDays: criteria.checkinDays,
            nights: criteria.nights,
            startDate: criteria.startDate,
            endDate: criteria.endDate,
          },
          { signal: aborter.signal },
        )) {
          send(event);
        }
      } catch (err) {
        const message =
          err instanceof ValidationError ? "That search isn't valid." : "We couldn't reach ReserveCalifornia just now.";
        logger.warn({ action: "search.progress_failed", err }, "search progress stream failed");
        send({ type: "error", message });
      } finally {
        request.signal.removeEventListener("abort", abort);
        if (open) {
          try {
            controller.close();
          } catch {
            // Already closed by the client disconnecting.
          }
        }
      }
    },
    cancel() {
      aborter.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      // no-transform and X-Accel-Buffering keep proxies (nginx on the Pi) from
      // buffering the stream and delivering it all at once at the end.
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
