import { ScanQueueFullError } from "@campingmeow/scanner";
import { ForbiddenError } from "~/lib/errors";
import { authService } from "~/services/auth.service.server";
import { adminService } from "~/services/admin.service.server";
import type { Route } from "./+types/api.recheck-facilities";

/**
 * Re-scan campgrounds marked non-bookable. Admin-only, and slow — it queues
 * behind the scanner at the shared one-per-second gate, so ~180 campgrounds
 * takes a few minutes.
 *
 * It is also the one place a person can queue hundreds of requests with one
 * click, so it is where the gate's backlog cap actually bites.
 */
export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const user = await authService.getAuthenticatedUser(request);
  if (!user) return new Response("Unauthorized", { status: 401 });

  try {
    return Response.json(await adminService.recheckNonBookable(user));
  } catch (err) {
    if (err instanceof ForbiddenError) return new Response("Forbidden", { status: 403 });
    if (err instanceof ScanQueueFullError) {
      return new Response(err.message, { status: 503, headers: { "Retry-After": "60" } });
    }
    throw err;
  }
}
