import { authService } from "../services/auth.service.server";
import { catalogService } from "../services/catalog.service.server";
import type { Route } from "./+types/api.catalog-sync";

// TODO(phase 5): restrict to admin permission once RBAC lands.
export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  const user = await authService.getAuthenticatedUser(request);
  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }
  const result = await catalogService.sync();
  return Response.json(result);
}
