import { ForbiddenError } from "~/lib/errors";
import { authService } from "~/services/auth.service.server";
import { availabilityService } from "~/services/availability.service.server";
import type { Route } from "./+types/api.recheck-facilities";

/**
 * Re-scan campgrounds marked non-bookable. Admin-only, and slow — it queues
 * behind the scanner at the shared one-per-second gate, so ~180 campgrounds
 * takes a few minutes.
 */
export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const user = await authService.getAuthenticatedUser(request);
  if (!user) return new Response("Unauthorized", { status: 401 });

  try {
    return Response.json(await availabilityService.recheckNonBookable(user));
  } catch (err) {
    if (err instanceof ForbiddenError) return new Response("Forbidden", { status: 403 });
    throw err;
  }
}
