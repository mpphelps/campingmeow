# CampingMeow — CLAUDE.md

## Working Agreement (mandates)
1. **Communication:** Speak to Michael in concise, simple terms.
2. **Learning project:** Michael writes the code from here on. Claude guides — explains approaches, reviews code, answers questions, points to files — but does not write feature code unless explicitly asked. (Initial scaffold was Claude-built; that phase is over.)

## Project Overview
Campsite reservation finder for California state parks (ReserveCalifornia). Users sign in, define campground/date-pattern watches, and get notified when matching sites open. Template: the Bookshelf project (`../Bookshelf`) — same stack, same conventions.

## Tech Stack
- **Framework:** React Router v7 with React 19, TypeScript, Vite
- **Styling:** Tailwind CSS v4, shadcn-style components in `packages/ui`
- **ORM:** Prisma v7 with PostgreSQL 17 (Docker), `@prisma/adapter-pg` driver adapter
- **Monorepo:** Turborepo with npm workspaces
- **Testing:** Playwright (e2e)

## Monorepo Structure
- `apps/web` — React Router app (frontend + server routes)
- `packages/database` — Prisma schema, migrations, and client singleton
- `packages/scanner` — Thin ReserveCalifornia API client, no business logic (see `packages/scanner/API.md`)
- `packages/ui` — Shared React components
- `packages/eslint-config` — Shared ESLint configs
- `packages/typescript-config` — Shared TS configs

## Backend Architecture (Strict)
All features must follow the layered architecture defined in **PROJECT_SPEC.md §7** (routes → services → repositories → display-only UI, service naming, scanner's role). Read that section before writing or reviewing backend code; it is the single source of truth.

## Key Commands
```bash
# Root
npm run dev              # Start all apps via Turbo
npm run build            # Build all apps/packages

# Docker
docker compose up -d     # Start Postgres (dev on 5434, test on 5435)
docker compose down      # Stop Postgres

# Database (from packages/database)
npx prisma migrate dev --name <name>   # Create + apply migration
npx prisma migrate deploy              # Apply pending migrations (prod)
npx prisma generate                    # Regenerate client from schema
npx prisma migrate dev --create-only   # Generate SQL without applying (for review)
```

## Environment
- Single `.env` in `packages/database/` — contains `DATABASE_URL`, `SESSION_SECRET`, `AUTH0_*`
- `apps/web/vite.config.ts` has `envDir` pointing to `../../packages/database`
- Database: `postgresql://campingmeow:campingmeow@localhost:5434/campingmeow`
- Test database: port 5435, `campingmeow_test` — configured via `.env.test`

## Data Model
- **User** — id, email (unique), firstName, lastName, timestamps. Synced from Auth0 on first login.
- (Coming: Watch — a campground + date-pattern subscription; notification delivery records.)

## Migration Policy
- Always inspect generated SQL before applying (`--create-only`)
- Consider impact on existing data before running migrations
- Use expand/contract pattern for structural changes
- Backfill data in migration SQL when adding required columns

## Authentication & Authorization
- **Auth provider:** Auth0 (OAuth 2.0 Authorization Code flow with PKCE)
- **Session:** JWT stored in encrypted HTTP-only session cookie (server-side)
- **JWT validation:** Signature verified against Auth0 JWKS on each request
- **Permissions:** Embedded in JWT claims, checked in the service layer
- **User sync:** On first login, Auth0 profile is used to create a local User record
- **E2E bypass:** `E2E_AUTH_BYPASS=1` enables `/auth/test-login` (404 in production)

## Testing
- **E2E (Playwright):** `apps/web/e2e/`, runs against `campingmeow_test` DB on port 5435, app on port 5174
- `globalSetup` runs `prisma migrate deploy`; `cleanDb` fixture truncates tables between tests
- Suite-level auth via `test.use({ user: ... })` + `page` fixture override

## Agents
- **e2e-test-runner** — Use this agent for all Playwright work: creating tests, running tests, debugging failures.

## Conventions
- Route files use React Router v7 typed conventions (`Route.LoaderArgs`, `Route.ComponentProps`)
- Database package imported as `@campingmeow/database`
- Prisma client uses `@prisma/adapter-pg` driver adapter (required in Prisma v7)
- ReserveCalifornia API calls must be polite: resolve base URL from `reservecalifornia.com/config.json`, delay between requests (see `packages/scanner`)
