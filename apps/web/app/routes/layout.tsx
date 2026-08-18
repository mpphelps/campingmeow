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
      <header className="border-b">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <nav className="flex items-center gap-5">
            <Link to="/" className="text-sm font-semibold">
              Camping Meow
            </Link>
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
