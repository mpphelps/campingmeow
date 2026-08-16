import { Link } from "react-router";

import { Button } from "@campingmeow/ui/components/button";
import type { Route } from "./+types/home";
import { authService } from "~/services/auth.service.server";

export async function loader({ request }: Route.LoaderArgs) {
  const user = await authService.getAuthenticatedUser(request);
  return { user };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { user } = loaderData;

  return (
    <div className="min-h-screen">
      <header className="border-b">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Link to="/" className="text-sm font-semibold">
            Camping Meow
          </Link>
          <div className="flex items-center gap-3">
            {user ? (
              <>
                <span className="text-sm text-muted-foreground">Welcome, {user.firstName}</span>
                <Button variant="outline" size="sm" asChild>
                  <a href="/auth/logout">Log out</a>
                </Button>
              </>
            ) : (
              <Button variant="outline" size="sm" asChild>
                <a href="/auth/login">Log in</a>
              </Button>
            )}
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
        <h1 className="text-2xl font-semibold tracking-tight">Find open California campsites</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Camping Meow watches ReserveCalifornia for cancellations and openings matching the dates you care about, and lets you
          know the moment something opens up. Park browsing and watches are on the way.
        </p>
      </main>
    </div>
  );
}
