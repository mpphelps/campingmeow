import { ScanQueueFullError } from "@campingmeow/scanner";
import { ForbiddenError } from "~/lib/errors";
import { authService } from "../services/auth.service.server";
import { catalogService } from "../services/catalog.service.server";
import type { Route } from "./+types/api.catalog-sync";

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  const user = await authService.getAuthenticatedUser(request);
  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }
  try {
    const result = await catalogService.sync(user);
    return Response.json(result);
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return new Response("Forbidden", { status: 403 });
    }
    if (err instanceof ScanQueueFullError) {
      return new Response(err.message, { status: 503, headers: { "Retry-After": "60" } });
    }
    throw err;
  }
}
