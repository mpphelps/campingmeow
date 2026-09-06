import { type RouteConfig, index, layout, route } from "@react-router/dev/routes";

export default [
  layout("routes/layout.tsx", [
    index("routes/home.tsx"),
    route("parks", "routes/parks.tsx"),
    route("parks/:parkId", "routes/parks.$parkId.tsx"),
    route("parks/:parkId/:facilityId", "routes/parks.$parkId.$facilityId.tsx"),
    route("search", "routes/search.tsx"),
    route("preferences", "routes/preferences.tsx"),
    route("watches", "routes/watches.tsx"),
    route("watches/new", "routes/watches.new.tsx"),
    route("admin", "routes/admin.tsx"),
  ]),
  route("health", "routes/health.tsx"),
  route("robots.txt", "routes/robots.ts"),
  route("sitemap.xml", "routes/sitemap.ts"),
  route("auth/login", "routes/auth.login.ts"),
  route("auth/callback", "routes/auth.callback.ts"),
  route("auth/logout", "routes/auth.logout.ts"),
  route("auth/test-login", "routes/auth.test-login.ts"),
  route("api/catalog-sync", "routes/api.catalog-sync.ts"),
  route("api/geocode", "routes/api.geocode.ts"),
  route("api/recheck-facilities", "routes/api.recheck-facilities.ts"),
] satisfies RouteConfig;
