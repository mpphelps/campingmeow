# CampingMeow — Deployment Runbook

End-to-end setup for self-hosting CampingMeow on the Raspberry Pi 5 behind Cloudflare Tunnel, with GitHub Actions CI/CD, nightly encrypted backups, and GitHub-managed production secrets.

**This Pi is shared with Bookshelf** (`~/Bookshelf`, port 3000, readingbookshelf.com). CampingMeow runs alongside it: same tunnel, same Docker daemon, same B2 account — but its own compose project, port (**3001**), runner, bucket, and healthcheck. Bookshelf's [`DEPLOYMENT.md`](../Bookshelf/DEPLOYMENT.md) documents the from-scratch Pi setup (Docker, cloudflared install, rclone install, ECN fix); this doc covers what CampingMeow adds on top.

## Table of contents

- [Architecture overview](#architecture-overview)
- [Initial-setup lifecycle (one-time)](#initial-setup-lifecycle-one-time)
- [Cloudflare Tunnel (shared with Bookshelf)](#cloudflare-tunnel-shared-with-bookshelf)
- [Cloudflare rate limiting](#cloudflare-rate-limiting)
- [GitHub Actions self-hosted runner](#github-actions-self-hosted-runner)
- [CI/CD workflows](#cicd-workflows)
- [Secret management](#secret-management)
- [Viewing application logs](#viewing-application-logs)
- [Nightly Postgres backups](#nightly-postgres-backups)
- [Manual backup](#manual-backup-on-demand)
- [Restore to production (rollback)](#restore-to-production-rollback--disaster-recovery)
- [Restoring on a new Pi (full disaster recovery)](#restoring-on-a-new-pi-full-disaster-recovery)

## Architecture overview

```
        ┌─────────────────────┐         ┌──────────────────────────────┐
visitor─┤ Cloudflare edge (TLS)├────────┤ cloudflared (Pi, shared)     │
        └─────────────────────┘  HTTPS  │  readingbookshelf.com → 3000 │
                                        │  campingmeow.com      → 3001 │
                                        └──────────────┬───────────────┘
                                                       │ plain HTTP
                                                       ▼
                                  ┌────────────────────────────────┐
                                  │ campingmeow-prod compose stack │
                                  │  ┌──────────────┐ ┌─────────┐  │
                                  │  │ app 3001:3000│▶│ db:5432 │  │
                                  │  └──────────────┘ └────┬────┘  │
                                  └───────────────────────│────────┘
                                                          │
                              ┌───────────────────────────┘
                              ▼
   GitHub PR + merge ─▶ CI ─▶ CD ─▶ self-hosted runner on Pi:
                                     - git fetch + reset --hard
                                     - materialize .env from GH Secrets
                                     - docker compose up -d --build
                                     - curl localhost:3001/health
                                     - docker image prune

   3:30 AM nightly ─▶ systemd timer ─▶ campingmeow-backup.sh:
                                     - docker exec pg_dump -Fc
                                     - rclone copy (encrypted) → B2
                                     - prune local 7d / remote 30d
                                     - ping healthchecks.io
```

## Initial-setup lifecycle (one-time)

Two things flip between "set up once by hand" and "managed by CD" during initial setup:

| | Before first deploy | After first deploy |
|---|---|---|
| `~/campingmeow/packages/database/.env` on the Pi | Doesn't need to exist — CD creates it | **CD overwrites it on every deploy** from GitHub Secrets. Manual edits are clobbered. |
| `cloudflared` config | Manual setup (add ingress rules) | Stays put; nothing automated touches it |
| `~/scripts/campingmeow-backup.sh` | You copy it from `scripts/backup.sh` in the repo and edit constants | Stays put; nothing automated touches it |
| Docker Compose stack | Created by the first CD run | CD owns deploys |

Setup order (zero → running production):

1. [Cloudflare Tunnel](#cloudflare-tunnel-shared-with-bookshelf) — add campingmeow.com to the existing tunnel
2. [GitHub Actions self-hosted runner](#github-actions-self-hosted-runner) — second runner on the Pi
3. [Secret management](#secret-management) — add the 7 secrets to GitHub
4. Auth0 — add production callback/logout URLs to the CampingMeow application
5. [CI/CD workflows](#cicd-workflows) — trigger CD, watch first deploy
6. [Nightly Postgres backups](#nightly-postgres-backups) — turn on backups + restore drill

## Cloudflare Tunnel (shared with Bookshelf)

One tunnel (named `bookshelf`, UUID in `/etc/cloudflared/config.yml`) serves both sites. The ingress rules route by hostname. cloudflared install and tunnel creation are documented in Bookshelf's runbook — CampingMeow only adds rules and DNS records.

### 1. Add ingress rules

Edit `/etc/cloudflared/config.yml` (the systemd copy — **not** `~/.cloudflared/config.yml`). Add the campingmeow hostnames *above* the required `http_status:404` catch-all:

```yaml
ingress:
  - hostname: readingbookshelf.com
    service: http://localhost:3000
  - hostname: www.readingbookshelf.com
    service: http://localhost:3000
  - hostname: campingmeow.com
    service: http://localhost:3001
  - hostname: www.campingmeow.com
    service: http://localhost:3001
  - service: http_status:404
```

Then:

```bash
sudo systemctl restart cloudflared
```

### 2. DNS records — use the dashboard, not the CLI

**Do not use `cloudflared tunnel route dns` for campingmeow.com.** The `cert.pem` from the original `tunnel login` is scoped to the readingbookshelf.com zone, so the CLI silently creates garbage records like `campingmeow.com.readingbookshelf.com` inside the wrong zone instead of failing.

Instead, in the Cloudflare dashboard → **campingmeow.com zone → DNS → Records**, add two records:

| Type | Name | Target | Proxy |
|---|---|---|---|
| CNAME | `@` | `<TUNNEL-UUID>.cfargotunnel.com` | Proxied |
| CNAME | `www` | `<TUNNEL-UUID>.cfargotunnel.com` | Proxied |

The tunnel UUID is the `tunnel:` line in `/etc/cloudflared/config.yml`.

### 3. Verify

```bash
curl -I https://campingmeow.com
```

- **502** — correct *before* the first deploy (tunnel works, nothing on port 3001 yet)
- **404** — hostname reached the tunnel but matched no ingress rule: wrong config file edited, or cloudflared not restarted. Test with `cloudflared tunnel ingress rule https://campingmeow.com --config /etc/cloudflared/config.yml`
- **200** — after the first deploy, this is the steady state

### Server-sent events through the tunnel

`/api/search-progress` streams progress while a search re-scans stale campgrounds. It only
works if nothing between the app and the browser buffers the response — a buffering proxy
holds every event until the stream ends, so the page sits still for the whole refresh and
then jumps to the final answer. It looks like "SSE is broken in prod" but nothing errors.

The app sets `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, and
`X-Accel-Buffering: no`, which cloudflared and Cloudflare both honour. If a reverse proxy is
ever put in front (nginx), it also needs `proxy_buffering off;` on that location.

Verify after a deploy — events should trickle in over ~7s each, not arrive all at once:

```bash
curl -N "https://campingmeow.com/api/search-progress?facilities=<id>&days=5&nights=2&bounds=anytime"
```

### Troubleshooting

- **Bookshelf broke after editing config** — YAML indent error. Run `cloudflared tunnel ingress validate --config /etc/cloudflared/config.yml`.
- **Search progress bar never moves, then results appear at the end** — something is buffering the SSE stream; see above.
- **Auth0 "Callback URL mismatch"** — the allowed list and the `AUTH0_CALLBACK_URL` secret must both be exactly `https://campingmeow.com/auth/callback` (not `www.`, not `http://`).
- **Infinite redirect loop after login** — session cookie is `Secure`-only in prod but the request reached the app over plain HTTP. Access via the tunnel domain, not `http://<pi-ip>:3001`.

## Cloudflare rate limiting

campingmeow.com is its own Cloudflare zone, so it gets its own free-plan rate-limiting rule (1 per zone). Dashboard → **campingmeow.com → Security → WAF → Rate limiting rules → Create rule**:

| Field | Value |
|---|---|
| Rule name | `campingmeow-app-throttle` |
| Filter mode | Custom filter expression |
| Expression | `(starts_with(http.request.uri.path, "/auth/"))` |
| Action | `Block` |
| Requests | `100` |
| Period | `1 minute` |
| Counting characteristics | `IP` |
| Action duration | `10 seconds` |

Extend the expression as mutation routes are added (watches, etc.), mirroring Bookshelf's combined rule.

## GitHub Actions self-hosted runner

The Pi runs **two** runner services — one per repo (runners are repo-scoped). Bookshelf's lives in `~/actions-runner`; CampingMeow's in `~/actions-runner-campingmeow`. They coexist because `svc.sh` names each systemd unit after `<owner>-<repo>`.

### Setup

1. GitHub: campingmeow repo → **Settings → Actions → Runners → New self-hosted runner** → Linux / ARM64. Keep the page open (token expires in ~1 h).
2. On the Pi, using the download/config commands from that page:

```bash
mkdir ~/actions-runner-campingmeow && cd ~/actions-runner-campingmeow
# curl + shasum + tar commands from the GitHub page
./config.sh --url https://github.com/<you>/campingmeow --token <ONE-TIME-TOKEN>
# accept defaults for all prompts
sudo ./svc.sh install
sudo ./svc.sh start
sudo ./svc.sh status
```

3. Verify: repo → Settings → Actions → Runners shows the runner **Idle** with a green dot.

Troubleshooting is identical to Bookshelf's runbook (labels mismatch, offline runner, docker group membership).

## CI/CD workflows

Two workflows in `.github/workflows/`:

- **`ci.yml`** — every PR + pushes to `main`: `lint`, `check-types`, `build`, `e2e` (Postgres service container + Playwright). Hosted Ubuntu runners.
- **`cd.yml`** — after CI succeeds on `main` (`workflow_run`), or manually via **Run workflow** (`workflow_dispatch`). Runs on the Pi runner:
  1. `git fetch + reset --hard origin/main` in `~/campingmeow`
  2. Materialize `.env` from GitHub Secrets (refuses to run if any secret is empty)
  3. `docker compose -f docker-compose.prod.yml up -d --build` — compose project `campingmeow-prod`, app image built on the Pi, `pgdata_prod` volume
  4. Wait up to 60 s for `curl localhost:3001/health`
  5. `docker image prune -f`

The app container runs `prisma migrate deploy` on every start, so a fresh volume auto-applies all migrations.

Branch protection (Settings → Branches, ruleset on `main`): PR required, all four CI checks required, direct pushes and force pushes blocked, squash-only merges.

## Secret management

Production secrets live only in GitHub Actions repository secrets. CD materializes `~/campingmeow/packages/database/.env` (mode 600) on every deploy; manual edits on the Pi are clobbered.

| Secret | What |
|---|---|
| `POSTGRES_PASSWORD` | DB user password (rotate via `ALTER ROLE` + secret update + redeploy) |
| `SESSION_SECRET` | Encrypts the session cookie |
| `AUTH0_DOMAIN` | Auth0 tenant hostname |
| `AUTH0_CLIENT_ID` | Auth0 CampingMeow app client ID |
| `AUTH0_CLIENT_SECRET` | Auth0 CampingMeow app client secret |
| `AUTH0_AUDIENCE` | `https://campingmeow-api` |
| `AUTH0_CALLBACK_URL` | `https://campingmeow.com/auth/callback` |

Non-secret constants (`POSTGRES_USER=campingmeow`, `POSTGRES_DB=campingmeow`) are hardcoded in `cd.yml`; `DATABASE_URL` is derived there from `POSTGRES_PASSWORD` so the two can't drift.

Rotation and adding new env vars: same procedure as Bookshelf's runbook (update secret → for DB password also `ALTER ROLE` on the live DB → trigger deploy; new vars get added to the `env:` block, heredoc, and sanity-check loop in `cd.yml`).

## Viewing application logs

Structured pino JSON on stdout, captured by Docker. Scan actions are tagged (`scan.start`, `scan.complete`).

```bash
docker logs -f campingmeow-prod-app-1            # tail live
docker logs --since 1h campingmeow-prod-app-1    # last hour
docker logs campingmeow-prod-app-1 | grep '"action":"scan.complete"'
docker logs campingmeow-prod-app-1 | grep -E '"level":(40|50|60)'   # warn+
```

`LOG_LEVEL` (default `info`) is read at container start; bump to `debug` via secret + redeploy, or one-off:

```bash
cd ~/campingmeow
LOG_LEVEL=debug docker compose -f docker-compose.prod.yml \
  --env-file packages/database/.env up -d --force-recreate app
```

## Nightly Postgres backups

Same pattern as Bookshelf: nightly `pg_dump` → rclone crypt → Backblaze B2, healthchecks.io dead-man's switch. CampingMeow gets its **own** bucket, rclone remotes, healthcheck, script, and timer — sharing a remote would mix the two projects' files and the prune steps would manage each other's dumps.

Already done on the Pi (skip): rclone install, ECN fix.

### 1. Create the destination + monitoring

**Backblaze B2** (existing account):

1. Create a new **private** bucket (e.g. `campingmeow-backups`) with SSE-B2 enabled.
2. Generate an application key scoped to that bucket, Read+Write. Save `keyID` + `applicationKey` immediately.

**Healthchecks.io** (existing account):

1. Add a check named `campingmeow-backup`: period **1 day**, grace **6 hours**.
2. Save its ping URL (`https://hc-ping.com/<uuid>`).

Each backup job needs its own check — a shared check would let one project's silence hide behind the other's successful pings.

### 2. Configure rclone (two new remotes)

Generate a fresh passphrase + salt and **save both to your password manager** (losing them = unreadable backups):

```bash
openssl rand -base64 32   # run twice: passphrase, then salt
```

`rclone config`, two remotes:

- **`campingmeow-b2`** — type `b2`, the new keyID/applicationKey, `hard_delete: false`
- **`campingmeow-b2-crypt`** — type `crypt`, remote `campingmeow-b2:campingmeow-backups/encrypted`, filename_encryption `standard`, directory_name_encryption `true`, password/password2 = the values you just generated

Round-trip check:

```bash
echo "test" > /tmp/test.txt
rclone copy /tmp/test.txt campingmeow-b2-crypt:
rclone ls campingmeow-b2-crypt:
rclone delete campingmeow-b2-crypt:test.txt && rm /tmp/test.txt
```

### 3. Install the backup script

The script is checked into the repo at `scripts/backup.sh` with campingmeow constants (`DB_CONTAINER=campingmeow-prod-db-1`, `DB_NAME`/`DB_USER=campingmeow`, `RCLONE_REMOTE=campingmeow-b2-crypt:`). Copy and personalize:

```bash
mkdir -p ~/scripts
cp ~/campingmeow/scripts/backup.sh ~/scripts/campingmeow-backup.sh
chmod +x ~/scripts/campingmeow-backup.sh
nano ~/scripts/campingmeow-backup.sh   # set HC_PING_URL to the campingmeow-backup check
```

Test directly, then verify all three destinations: `ls ~/backups/` (a `campingmeow-*.dump` file), `rclone ls campingmeow-b2-crypt:`, green ping on healthchecks.io.

### 4. Schedule via systemd timer

**3:30 AM** — offset from Bookshelf's 3:00 run so the two backups don't contend on the Pi.

```bash
sudo tee /etc/systemd/system/campingmeow-backup.service > /dev/null << 'EOF'
[Unit]
Description=CampingMeow Postgres backup
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=mpphelps
ExecStart=/home/mpphelps/scripts/campingmeow-backup.sh
StandardOutput=journal
StandardError=journal
EOF

sudo tee /etc/systemd/system/campingmeow-backup.timer > /dev/null << 'EOF'
[Unit]
Description=Run CampingMeow Postgres backup nightly

[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true
RandomizedDelaySec=15m

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now campingmeow-backup.timer
systemctl list-timers campingmeow-backup.timer
```

Verify via systemd (matches the nightly environment exactly):

```bash
sudo systemctl start campingmeow-backup.service
sudo journalctl -u campingmeow-backup.service -n 50 --no-pager
```

### 5. Test the restore path (quarterly drill)

```bash
LATEST=$(rclone ls campingmeow-b2-crypt: | awk '{print $2}' | sort | tail -1)
rclone copy "campingmeow-b2-crypt:$LATEST" /tmp/

docker run -d --name campingmeow-restore-test \
  -e POSTGRES_USER=campingmeow -e POSTGRES_PASSWORD=campingmeow -e POSTGRES_DB=campingmeow \
  postgres:17
sleep 5

docker cp "/tmp/$LATEST" campingmeow-restore-test:/tmp/backup.dump
docker exec campingmeow-restore-test pg_restore -U campingmeow -d campingmeow -v /tmp/backup.dump

# Row counts must match prod
docker exec campingmeow-restore-test \
  psql -U campingmeow -d campingmeow -c 'SELECT COUNT(*) AS users FROM "User";'
docker exec campingmeow-prod-db-1 \
  psql -U campingmeow -d campingmeow -c 'SELECT COUNT(*) AS users FROM "User";'

docker stop campingmeow-restore-test && docker rm campingmeow-restore-test
rm "/tmp/$LATEST"
```

### Troubleshooting

Same failure modes as Bookshelf's runbook: rclone hanging = ECN issue; "refers to a local folder" = missing trailing colon on the remote; healthchecks "down" with a healthy Pi = check `journalctl -u campingmeow-backup.service` for the real exit status.

## Manual backup (on demand)

Before a risky migration or maintenance:

```bash
sudo systemctl start campingmeow-backup.service     # preferred: same env as nightly
sudo journalctl -u campingmeow-backup.service -f
```

or `~/scripts/campingmeow-backup.sh` directly. Either way: timestamped dump in `~/backups/`, encrypted upload to B2, healthcheck ping.

## Restore to production (rollback / disaster recovery)

The dangerous operation. Read every step first. CampingMeow is offline during the restore; Bookshelf is unaffected.

```bash
# 1. Snapshot current state first (even if broken — you may need it later)
sudo systemctl start campingmeow-backup.service
rclone ls campingmeow-b2-crypt: | sort | tail -3

# 2. Pick the dump (ISO-8601 filenames: lexical sort = chronological)
rclone ls campingmeow-b2-crypt: | sort
RESTORE_FILE="campingmeow-<timestamp>.dump"   # ← edit

# 3. Download
rclone copy "campingmeow-b2-crypt:$RESTORE_FILE" /tmp/

# 4. Stop the app (DB stays up; we restore into it)
cd ~/campingmeow
docker compose -f docker-compose.prod.yml --env-file packages/database/.env stop app

# 5. Drop, recreate, restore
docker cp "/tmp/$RESTORE_FILE" campingmeow-prod-db-1:/tmp/restore.dump
docker exec campingmeow-prod-db-1 \
  psql -U campingmeow -d postgres -c 'DROP DATABASE campingmeow WITH (FORCE);'
docker exec campingmeow-prod-db-1 \
  psql -U campingmeow -d postgres -c 'CREATE DATABASE campingmeow OWNER campingmeow;'
docker exec campingmeow-prod-db-1 \
  pg_restore -U campingmeow -d campingmeow -v /tmp/restore.dump
# watch for ERROR lines; ownership warnings are usually ignorable, data errors are not

# 6. Restart the app
docker compose -f docker-compose.prod.yml --env-file packages/database/.env start app

# 7. Verify
curl -fs https://campingmeow.com/health
docker exec campingmeow-prod-db-1 \
  psql -U campingmeow -d campingmeow -c 'SELECT COUNT(*) FROM "User";'
# then log in via the browser and eyeball the data

# 8. Clean up
rm "/tmp/$RESTORE_FILE"
docker exec campingmeow-prod-db-1 rm /tmp/restore.dump
```

## Restoring on a new Pi (full disaster recovery)

If the Pi dies, **both sites** die — recover both. Critical prerequisite: rclone crypt passphrases + salts (both projects') in your password manager.

1. New Pi: OS, SSH, Docker, Docker Compose.
2. Cloudflare Tunnel: reinstall cloudflared, restore `/etc/cloudflared/` (config + tunnel credentials JSON) from backup or re-create the tunnel. The shared config carries **both sites'** ingress rules. DNS follows the tunnel UUID automatically if the same tunnel is reused; a new tunnel means updating the CNAME targets in **both zones**.
3. `git clone https://github.com/<you>/campingmeow ~/campingmeow` (and Bookshelf to `~/Bookshelf`).
4. Disable ECN (see Bookshelf runbook).
5. Recreate `packages/database/.env` from your password manager (one-time; CD re-owns it after the runner is back).
6. `docker compose -f docker-compose.prod.yml --env-file packages/database/.env up -d` — migrations auto-apply; DB starts empty.
7. rclone config with the **saved** passphrase + salt (must match what encrypted the existing backups).
8. [Restore to production](#restore-to-production-rollback--disaster-recovery) from the latest dump.
9. Reinstall both GHA runners, and both backup timers.
10. Auth0 needs no changes — same domains, new Pi behind the same tunnel.
