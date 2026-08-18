import { ValidationError } from "~/lib/errors";
import { geocodeService } from "~/services/geocode.service.server";
import type { Route } from "./+types/api.geocode";

export async function loader({ request }: Route.LoaderArgs) {
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
