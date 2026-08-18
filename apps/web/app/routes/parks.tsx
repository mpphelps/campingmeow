import { redirect } from "react-router";
import type { Route } from "./+types/parks";

// The parks browser lives on the home page now; keep old links working.
export async function loader({ request }: Route.LoaderArgs) {
  const query = new URL(request.url).searchParams.get("q");
  return redirect(query ? `/?q=${encodeURIComponent(query)}` : "/");
}
