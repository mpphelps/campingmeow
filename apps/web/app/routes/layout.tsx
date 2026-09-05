import { useState } from "react";
import { Link, NavLink, Outlet } from "react-router";
import { MenuIcon } from "lucide-react";

import { Button } from "@campingmeow/ui/components/button";
import { Sheet, SheetClose, SheetContent, SheetTrigger } from "@campingmeow/ui/components/sheet";
import { Toaster } from "@campingmeow/ui/components/toast";
import type { Route } from "./+types/layout";
import { authService } from "~/services/auth.service.server";

export async function loader({ request }: Route.LoaderArgs) {
  const user = await authService.getAuthenticatedUser(request);
  return { user };
}

export default function Layout({ loaderData }: Route.ComponentProps) {
  const { user } = loaderData;
  const [menuOpen, setMenuOpen] = useState(false);

  const links = [
    ...(user ? [{ to: "/watches", label: "My watches" }] : []),
    ...(user?.permissions.includes("admin:site") ? [{ to: "/admin", label: "Admin" }] : []),
    ...(user ? [{ to: "/preferences", label: "Settings" }] : []),
  ];

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    `text-sm ${isActive ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`;

  return (
    <div className="min-h-screen">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-2.5 sm:px-6">
          <Link to="/" className="flex min-w-0 items-center gap-2">
            <img src="/favicon.svg" alt="" aria-hidden="true" className="size-7 shrink-0 rounded-md" />
            <span className="truncate font-display text-lg leading-none font-semibold">
              Camping<span className="text-poppy">Meow</span>
            </span>
          </Link>

          {/* The joke only fits beside the brand on wider screens; on mobile it
              moves to the strip below rather than being dropped. */}
          <span className="hidden font-display text-sm italic text-muted-foreground lg:inline">
            Let&apos;s go camping right meow.
          </span>

          {/* Inline nav from sm up; below that everything lives in the drawer,
              because five links plus a greeting has nowhere to go on a phone. */}
          <nav className="ml-auto hidden items-center gap-5 sm:flex">
            {links.map((link) => (
              <NavLink key={link.to} to={link.to} className={navLinkClass}>
                {link.label}
              </NavLink>
            ))}
            {user && <span className="hidden text-sm text-muted-foreground lg:inline">Welcome, {user.firstName}</span>}
            <Button variant="outline" size="sm" asChild>
              <a href={user ? "/auth/logout" : "/auth/login"}>{user ? "Log out" : "Log in"}</a>
            </Button>
          </nav>

          <div className="ml-auto sm:hidden">
            {links.length === 0 ? (
              <Button variant="outline" size="sm" asChild>
                <a href="/auth/login">Log in</a>
              </Button>
            ) : (
              <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
                <SheetTrigger asChild>
                  <Button variant="outline" size="icon" aria-label="Open menu">
                    <MenuIcon />
                  </Button>
                </SheetTrigger>
                <SheetContent title="Menu">
                  {user && (
                    <p className="mb-4 pr-8 text-sm text-muted-foreground">
                      Signed in as <span className="text-foreground">{user.firstName}</span>
                    </p>
                  )}
                  <div className="flex flex-col gap-1">
                    {links.map((link) => (
                      <SheetClose key={link.to} asChild>
                        <NavLink
                          to={link.to}
                          className={({ isActive }) =>
                            `rounded-md px-2 py-2 text-base ${
                              isActive ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent/50"
                            }`
                          }
                        >
                          {link.label}
                        </NavLink>
                      </SheetClose>
                    ))}
                  </div>
                  <Button variant="outline" className="mt-4 w-full" asChild>
                    <a href="/auth/logout">Log out</a>
                  </Button>
                </SheetContent>
              </Sheet>
            )}
          </div>
        </div>

        {/* Mobile home for the tagline: its own quiet strip, so it never
            competes with the brand or the menu button for width. */}
        <div className="border-t px-4 py-1.5 lg:hidden">
          <span className="font-display text-sm italic text-muted-foreground">Let&apos;s go camping right meow.</span>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
        <Outlet />
      </main>

      <Toaster />
    </div>
  );
}
