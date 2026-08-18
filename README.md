# CampingMeow 🏕️

Find open campsites in California state parks. CampingMeow watches ReserveCalifornia for cancellations and openings matching date patterns you care about (e.g. *any 1-night Saturday at Crystal Cove's Moro Campground*) and will notify you when something opens up.

Built on the same stack as [Bookshelf](https://github.com/mpphelps/Bookshelf): React Router v7, Prisma v7, Turborepo, Docker, self-hosted deployment.

## Stack

- **Framework:** React Router v7 + React 19 + TypeScript + Vite
- **Styling:** Tailwind CSS v4 (shadcn-style components in `packages/ui`)
- **ORM:** Prisma v7 with PostgreSQL 17 (via `@prisma/adapter-pg` driver adapter)
- **Monorepo:** Turborepo with npm workspaces
- **Auth:** Auth0 (OAuth 2.0 Authorization Code + PKCE)
- **Testing:** Playwright (e2e)
- **Deployment:** Docker + Docker Compose, self-hosted behind Cloudflare Tunnel

## Layout

```
apps/web/                       React Router app (routes, services, repos, components)
packages/database/              Prisma schema, migrations, prisma.config.ts, generated client
packages/scanner/               Thin ReserveCalifornia API client (see its README)
packages/ui/                    Shared React components (Button, Panel, etc.)
packages/eslint-config/         Shared ESLint config
packages/typescript-config/     Shared tsconfig
Dockerfile                      Multi-stage build for the web app
docker-entrypoint.sh            Runs `prisma migrate deploy`, then starts the server
docker-compose.yml              Dev: Postgres only (dev + test DBs)
docker-compose.prod.yml         Prod: app + Postgres (project name `campingmeow-prod`)
```

The web app follows a strict layered backend pattern (routes → services → repositories → display-only UI), defined in [`PROJECT_SPEC.md`](./PROJECT_SPEC.md) §7.

## Getting started

### Prerequisites

- Node.js ≥ 20
- Docker Desktop
- An Auth0 tenant (free tier)

### Setup

```bash
# Install dependencies
npm install

# Start Postgres (dev + test DBs)
docker compose up -d

# Fill in packages/database/.env with your values:
#   DATABASE_URL=postgresql://campingmeow:campingmeow@localhost:5434/campingmeow
#   SESSION_SECRET=<32+ char random string>
#   AUTH0_DOMAIN=<your-tenant>.auth0.com
#   AUTH0_CLIENT_ID=...
#   AUTH0_CLIENT_SECRET=...
#   AUTH0_AUDIENCE=...
#   AUTH0_CALLBACK_URL=http://localhost:5173/auth/callback

# Apply migrations
cd packages/database
npx prisma migrate deploy
cd ../..

# Run the app
npm run dev
```

App is at `http://localhost:5173`.

## Common commands

```bash
# Dev (from repo root)
npm run dev                              # Turbo: starts all apps
npm run build                            # Turbo: builds all apps + packages
docker compose up -d                     # Start Postgres
docker compose down                      # Stop Postgres

# Database (from packages/database)
npx prisma migrate dev --name <name>     # Create + apply migration
npx prisma migrate dev --create-only     # Generate SQL without applying (review first)
npx prisma migrate deploy                # Apply pending migrations (prod-style)
npx prisma generate                      # Regenerate client from schema

# E2E tests (from apps/web)
npm run test:e2e                         # Headless Playwright run
npm run test:e2e:headed                  # With browser UI

# ReserveCalifornia helpers (from packages/scanner)
npm run find -- "San Onofre"             # Look up park/facility IDs
```

## Production stack (local test)

```bash
docker compose -f docker-compose.prod.yml --env-file packages/database/.env up --build
```

Requires `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` in the `.env`. App is at `http://localhost:3001` (host port 3001 → container 3000; Bookshelf owns 3000 on the shared Pi); the container runs `prisma migrate deploy` on every start.

## Deployment

Production runs on a Raspberry Pi 5 (shared with Bookshelf) behind Cloudflare Tunnel at [campingmeow.com](https://campingmeow.com), deployed via GitHub Actions (CI on hosted runners, CD on a self-hosted runner on the Pi). Nightly encrypted backups go to Backblaze B2 with healthchecks.io alerting.

Full setup, troubleshooting, and disaster-recovery runbooks live in **[`DEPLOYMENT.md`](./DEPLOYMENT.md)**.

## Data model

- **User** — id, email (unique), firstName, lastName, timestamps. Created on first Auth0 login.
- **Park** / **Facility** — the ReserveCalifornia catalog, mirrored daily; RC ids kept as unique columns, disappeared records marked inactive.

Campground watches + notification service come next (extra Docker containers for the scanner worker and notifier). See [`PROJECT_SPEC.md`](./PROJECT_SPEC.md).

## License

Personal project. No license granted.
