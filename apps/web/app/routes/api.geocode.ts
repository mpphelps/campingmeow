import { ValidationError } from "~/lib/errors";
import { authService } from "~/services/auth.service.server";
import { geocodeService } from "~/services/geocode.service.server";
import type { Route } from "./+types/api.geocode";

/**
 * Signed-in only: this proxies OpenStreetMap Nominatim, whose usage policy caps
 * us at 1 request/second for the whole deployment. Left public it is an open
 * proxy, and anyone could burn that budget and get our IP blocked.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const user = await authService.getAuthenticatedUser(request);
  if (!user) {
    return Response.json({ error: "Sign in to search by address.", authRequired: true }, { status: 401 });
  }

  const query = new URL(request.url).searchParams.get("q");
  try {
    const result = await geocodeService.lookup(query);
    if (!result) return Response.json({ error: "We couldn't find that place." }, { status: 404 });
    return Response.json(result);
  } catch (err) {
    if (err instanceof ValidationError) {
      return Response.json({ error: Object.values(err.fields)[0] }, { status: 422 });
    }
    return Response.json({ error: "Location lookup is unavailable right now." }, { status: 502 });
  }
}
