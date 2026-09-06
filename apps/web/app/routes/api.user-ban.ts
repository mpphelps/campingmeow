import { ForbiddenError, ValidationError } from "~/lib/errors";
import { adminService } from "~/services/admin.service.server";
import { authService } from "~/services/auth.service.server";
import type { Route } from "./+types/api.user-ban";

/**
 * Ban or unban an account. Admin-only.
 *
 * A ban is reversible and destroys nothing: the account reads as signed out
 * everywhere and stops receiving email, but its watches and preferences are
 * still there when the ban is lifted.
 */
export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const user = await authService.getAuthenticatedUser(request);
  if (!user) return new Response("Unauthorized", { status: 401 });

  const form = await request.formData();
  const userId = String(form.get("userId") ?? "");
  const banned = form.get("banned") === "true";

  try {
    return Response.json(await adminService.setUserBanned(user, userId, banned));
  } catch (err) {
    if (err instanceof ForbiddenError) return new Response("Forbidden", { status: 403 });
    if (err instanceof ValidationError) {
      return Response.json({ error: Object.values(err.fields)[0] }, { status: 422 });
    }
    throw err;
  }
}
