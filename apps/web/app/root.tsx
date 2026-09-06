import { Link, Links, Meta, Outlet, Scripts, ScrollRestoration, isRouteErrorResponse } from "react-router";

import type { Route } from "./+types/root";
import { RouteErrorPanel } from "~/components/layout/route-error-panel";
import { scannerService } from "~/services/scanner.service.server";
import "./app.css";

/**
 * The only reliable server-side "app started" hook without owning a custom
 * entry.server. `start()` is idempotent, so paying for one function call per
 * request is cheaper than the boilerplate of revealing the entry module.
 */
export async function loader() {
  scannerService.start();
  return null;
}

export const links: Route.LinksFunction = () => [{ rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }];

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

export const headers: Route.HeadersFunction = () => ({
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  // geolocation=(self), not () — an empty allowlist blocks our own origin too,
  // so "Use my location" failed before the browser even prompted. Camera and
  // microphone stay fully off; we never use them.
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(self), interest-cohort=()",
  "Content-Security-Policy": CSP,
});

export const meta: Route.MetaFunction = () => [
  { title: "Camping Meow — find California campsites" },
  {
    name: "description",
    content: "Scout California state park campgrounds for open reservations and get notified when a site you want opens up.",
  },
  { property: "og:type", content: "website" },
  { property: "og:site_name", content: "Camping Meow" },
  { property: "og:title", content: "Camping Meow — find California campsites" },
  {
    property: "og:description",
    content: "Scout California state park campgrounds for open reservations.",
  },
  { name: "twitter:card", content: "summary" },
  { name: "twitter:title", content: "Camping Meow — find California campsites" },
  {
    name: "twitter:description",
    content: "Scout California state park campgrounds for open reservations.",
  },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:text-foreground focus:outline focus:outline-2 focus:outline-ring"
        >
          Skip to main content
        </a>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

function BrandmarkHeader() {
  return (
    <header className="border-b">
      <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3 sm:px-6">
        <Link to="/" className="text-sm font-semibold">
          Camping Meow
        </Link>
      </div>
    </header>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  if (isRouteErrorResponse(error)) {
    return (
      <>
        <BrandmarkHeader />
        <RouteErrorPanel status={error.status} message={error.data} />
      </>
    );
  }

  const message = error instanceof Error ? error.message : "Unknown error";
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const stack = import.meta.env.DEV && error instanceof Error ? error.stack : undefined;

  return (
    <>
      <BrandmarkHeader />
      <RouteErrorPanel status={500} message={message} />
      {stack && (
        <pre className="mx-auto max-w-3xl overflow-x-auto px-6 pb-12 font-mono text-xs text-muted-foreground">
          <code>{stack}</code>
        </pre>
      )}
    </>
  );
}
