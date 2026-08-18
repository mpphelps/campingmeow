import { ForbiddenError } from "~/lib/errors";
import { authService } from "../services/auth.service.server";
import { availabilityService } from "../services/availability.service.server";
import type { Route } from "./+types/api.scan-watched";

/** Starts a background sweep (?scope=watched|all) and reports its progress. */
export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  const user = await authService.getAuthenticatedUser(request);
  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  const scope = (await request.formData()).get("scope") === "all" ? "all" : "watched";
  try {
    return Response.json(await availabilityService.startSweep(user, scope));
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return new Response("Forbidden", { status: 403 });
    }
    throw err;
  }
}
