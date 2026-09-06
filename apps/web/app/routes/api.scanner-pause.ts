import { ForbiddenError } from "~/lib/errors";
import { adminService } from "~/services/admin.service.server";
import { authService } from "~/services/auth.service.server";
import type { Route } from "./+types/api.scanner-pause";

/**
 * Pause or resume the sweep without restarting the process.
 *
 * The scanner is the heaviest thing this box does and the only thing that
 * talks to ReserveCalifornia, so being able to stop it is how you tell "the
 * app is broken" from "the app is fine, the sweep isn't".
 */
export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const user = await authService.getAuthenticatedUser(request);
  if (!user) return new Response("Unauthorized", { status: 401 });

  const paused = (await request.formData()).get("paused") === "true";
  try {
    return Response.json(adminService.setScannerPaused(user, paused));
  } catch (err) {
    if (err instanceof ForbiddenError) return new Response("Forbidden", { status: 403 });
    throw err;
  }
}
