import { redirect } from "react-router";
import type { Route } from "./+types/auth.callback";
import { authService } from "../services/auth.service.server";
import { createSessionHeaders } from "../lib/session.server";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");

  if (!code) {
    throw new Response("Missing authorization code", { status: 400 });
  }

  const { accessToken } = await authService.handleCallback(code);
  const headers = await createSessionHeaders(accessToken);

  return redirect("/", { headers });
}
