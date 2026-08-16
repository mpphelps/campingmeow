import { type RouteConfig, route } from "@react-router/dev/routes";

export default [
  route("/", "routes/home.tsx"),
  route("health", "routes/health.tsx"),
  route("robots.txt", "routes/robots.ts"),
  route("sitemap.xml", "routes/sitemap.ts"),
  route("auth/login", "routes/auth.login.ts"),
  route("auth/callback", "routes/auth.callback.ts"),
  route("auth/logout", "routes/auth.logout.ts"),
  route("auth/test-login", "routes/auth.test-login.ts"),
  route("api/catalog-sync", "routes/api.catalog-sync.ts"),
] satisfies RouteConfig;
