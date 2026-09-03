import { Link, NavLink, Outlet } from "react-router";

import { Button } from "@campingmeow/ui/components/button";
import { Toaster } from "@campingmeow/ui/components/toast";
import type { Route } from "./+types/layout";
import { authService } from "~/services/auth.service.server";

export async function loader({ request }: Route.LoaderArgs) {
  const user = await authService.getAuthenticatedUser(request);
  return { user };
}

export default function Layout({ loaderData }: Route.ComponentProps) {
  const { user } = loaderData;

  return (
    <div className="min-h-screen">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-2.5 sm:px-6">
          <nav className="flex flex-wrap items-center gap-x-5 gap-y-1">
            <Link to="/" className="group flex items-center gap-2">
              <img src="/favicon.svg" alt="" aria-hidden="true" className="size-7 rounded-md" />
              <span className="font-display text-lg leading-none font-semibold">
                Camping<span className="text-poppy">Meow</span>
              </span>
            </Link>
            {/* Full-width on mobile so it drops to its own line under the brand
                rather than being hidden — it's the joke, and phones are where
                most people will see the header. */}
            <span className="w-full font-display text-sm italic text-muted-foreground sm:w-auto">
              Let&apos;s go camping right meow.
            </span>
            {user && (
              <NavLink
                to="/watches"
                className={({ isActive }) =>
                  `text-sm ${isActive ? "font-medium" : "text-muted-foreground hover:text-foreground"}`
                }
              >
                My watches
              </NavLink>
            )}
            {user?.permissions.includes("admin:site") && (
              <NavLink
                to="/admin"
                className={({ isActive }) =>
                  `text-sm ${isActive ? "font-medium" : "text-muted-foreground hover:text-foreground"}`
                }
              >
                Admin
              </NavLink>
            )}
          </nav>
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
        <Outlet />
      </main>

      <Toaster />
    </div>
  );
}
