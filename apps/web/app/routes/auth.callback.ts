import { redirect } from "react-router";
import type { Route } from "./+types/auth.callback";
import { authService } from "../services/auth.service.server";
import { createSessionHeaders, destroySessionHeaders } from "../lib/session.server";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");

  if (!code) {
    throw new Response("Missing authorization code", { status: 400 });
  }

  const { accessToken, banned } = await authService.handleCallback(code);

  // A banned account gets no session at all. Handing one out would leave them
  // looking signed out on every page with no way to find out why.
  if (banned) {
    return redirect("/account-closed", { headers: await destroySessionHeaders() });
  }

  const headers = await createSessionHeaders(accessToken);
  return redirect("/", { headers });
}
