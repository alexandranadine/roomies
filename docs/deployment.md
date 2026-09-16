# Deployment (M9.2 / M9.3)

M9.2 prepared the repository. M9.3 created an isolated **staging**
deployment and recorded live platform facts below.

Public production origin placeholders until a real Roomies domain exists:

- Frontend: `https://roomies.example`
- API: `https://api.roomies.example`

Do not invent or purchase a domain from this document. Staging uses
provider hostnames only (`*.up.railway.app`, `*.workers.dev`). Those
origins are not production.

Facts are marked **VERIFIED LIVE** (observed on the M9.3 staging stack) or
**CONFIGURED/EXPECTED** (set in provider config or required by code, not
re-observed as a raw container property).

## Topology

| Piece    | Platform                           | Notes                                         |
| -------- | ---------------------------------- | --------------------------------------------- |
| Frontend | Cloudflare Workers Static Assets   | SPA. No Pages config.                         |
| Backend  | One Railway Hobby service, US West | Combined web + worker process                 |
| Database | Neon PostgreSQL, AWS us-west-2     | Launch if PITR/backup expectations require it |
| Media    | Cloudflare R2                      | Later M9. Not provisioned here.               |

Initial HTTP topology is **one Railway service / one process**. Production
auto-sleep must be **OFF**. Replica count is **1** until in-process rate
limiting is replaced with a centralized store.

## Single HTTP replica

In-process rate limiting is valid only with one backend process. Do not enable
multiple Railway replicas, a second Railway HTTP service, or horizontal
autoscale.

Railway Config as Code (`railway.json` / `railway.toml`) is deprecated for
**new** services. This repo therefore does **not** ship a Railway manifest that
could be mistaken for live infrastructure. Replica count is a **dashboard
setting** (Scale → replicas = 1, region US West / `us-west2`). When a Railway
project exists, future Infrastructure as Code may encode `replicas: 1`; do not
`railway config apply` from this ticket.

Do not configure a Railway pre-deploy migrate command. Migrations are a
separate release step (below), not application startup.

## Node and npm

Frozen: **Node `>=24 <25`**, **npm `>=10`**. Declared on the root, backend, and
frontend `package.json` `engines` fields. Railpack reads `engines.node`.
Cloudflare frontend builds should use Node 24 as well.

Do not set `RAILPACK_NODE_VERSION` to another major. Production must not
silently run Node 22/25.

## Backend build and start

Railway service root: monorepo root.

| Setting          | Value                                                                   |
| ---------------- | ----------------------------------------------------------------------- |
| Install          | `npm ci` (lockfile)                                                     |
| Build            | `npm run build --workspace=@roomies/backend`                            |
| Start            | `npm run start:prod --workspace=@roomies/backend` (`node dist/main.js`) |
| Healthcheck path | `/ready`                                                                |
| `PROCESS_MODE`   | `combined` (default; HTTP + recurrence worker)                          |
| Auto-sleep       | Off                                                                     |
| Replicas         | 1                                                                       |

Build compiles `backend/src/main.ts` to `backend/dist/main.js` (esbuild). It
does not connect to Postgres and does not run migrations. Do not start
production with `tsx` / `ts-node`. Invalid config fails fast at process boot.

Local development remains `npm run dev --workspace=@roomies/backend` (`tsx`).

## Health vs readiness

| Path          | Meaning                                  | Success                  | Failure                      |
| ------------- | ---------------------------------------- | ------------------------ | ---------------------------- |
| `GET /health` | Process alive                            | `200 {"status":"ok"}`    | Process down                 |
| `GET /ready`  | Config valid (boot) + database reachable | `200 {"status":"ready"}` | `503 {"status":"not_ready"}` |

Liveness does not depend on Postgres. Readiness fails when the backend cannot
safely serve requests. Neither payload includes `DATABASE_URL`, credentials,
Better Auth secrets, env dumps, or stack traces.

When `RELEASE_SHA` or `RAILWAY_GIT_COMMIT_SHA` is a 7–40 character hex SHA,
successful probes also include `"release":"<sha>"`. `503` readiness omits it.

Railway deploy healthcheck should use **`/ready`** so a new replica is not
promoted until Postgres is reachable. `/health` is the liveness probe for
external monitors.

## Graceful shutdown

`SIGTERM` / `SIGINT` are owned by the combined process runtime:

1. Stop accepting new HTTP connections
2. Stop the worker from claiming new jobs
3. Allow bounded in-flight completion (`SHUTDOWN_TIMEOUT_MS` = 10s)
4. Stop the in-process rate-limit sweep timer
5. Close the Prisma client
6. Close the shared `pg.Pool` exactly once
7. Exit

There is one caller-owned pool, shared by Prisma 8, Better Auth, and the
worker. Do not add a second production pool.

## Neon database contract

### Runtime (`DATABASE_URL`) — required

Application `pg.Pool` (max 10, idle 30s, connect timeout 10s,
`application_name=roomies-backend`). Prefer the Neon **pooled** (`-pooler`)
connection string with `sslmode=require` (or `verify-full`). Do not disable
TLS. Do not set `pg` `rejectUnauthorized: false`.

The process composition root creates this pool once and passes it to Prisma 8
and Better Auth. Consumers never call `pool.end()`.

### Release migrate (`MIGRATION_DATABASE_URL`) — release-only

Prisma 8 `db migrate` / `db verify` need a session-capable **direct**
connection. Neon pooled hosts use PgBouncer transaction mode and are not valid
for this CLI. Set `MIGRATION_DATABASE_URL` to the Neon **unpooled** URL
(`sslmode=require`, hostname **without** `-pooler`).

Local/CI keep using `DATABASE_URL` only. Runtime config does **not** read
`MIGRATION_DATABASE_URL`.

## Release order

1. CI verification
2. **Migrate** (`npm run db:migrate:release`) against the target environment
3. Backend deploy
4. Readiness (`GET /ready`) + backend smoke
5. Frontend deploy
6. Frontend smoke

Production is **protected promotion**, not push-to-main deploy. Staging may
later auto-deploy verified `main`. This repository does not ship a GitHub
Actions production deploy job: the required platform secrets and resources do
not exist yet, and `check:ci-secrets` forbids workflow secret coupling.

## Migration command and failure

```bash
APP_ENV=production MIGRATION_DATABASE_URL=… npm run db:migrate:release
```

Applies committed reviewed Prisma 8 artifacts only (`prisma db migrate --yes`
then `prisma db verify --strict`). No `db push`, schema inference, interactive
`migration plan`, startup migrate, or destructive reset.

If production migration fails: **stop the release**. Do not deploy a new
backend or frontend. Investigate and fix forward. Do **not** automatically
reverse database migrations. Application rollback assumes expand-contract
compatible migrations.

## Better Auth (production)

| Item                    | Contract                                                           |
| ----------------------- | ------------------------------------------------------------------ |
| `AUTH_BASE_URL`         | HTTPS API origin (`https://api.roomies.example`)                   |
| `FRONTEND_ORIGIN`       | HTTPS frontend origin; must be listed in `TRUSTED_ORIGINS`         |
| `TRUSTED_ORIGINS`       | Exact HTTPS origins, comma-separated, no wildcards                 |
| `AUTH_SECRET`           | High-entropy, ≥32 characters, environment-specific                 |
| Cookies                 | `HttpOnly`, `Secure`, `SameSite=Lax`, **host-only** (no `Domain=`) |
| Cross-subdomain cookies | Not used. Frontend and API are different hosts.                    |

Do not put Better Auth secrets in Vite env.

## TRUST_PROXY (Railway US West)

Boolean `true` is rejected at boot (VERIFIED LIVE: `TRUST_PROXY=true`
exits with `Invalid configuration` and is not promoted).

**Proven hop count for this Railway edge: `2`.** (VERIFIED LIVE, M9.3
staging, region `us-west2`, service domain `*.up.railway.app`, no extra
CDN in front.)

Observed forwarding (hashes only; client IPs are not recorded here):

- Railway presents **exactly two** `X-Forwarded-For` hops, both public.
- Leftmost hop is the connecting client. Rightmost hop is a Railway edge
  address and **rotates** across requests.
- Railway **overwrites** client-supplied `X-Forwarded-For` and
  `X-Real-IP`. Attacker canaries (`198.51.100.123` and multi-value
  lists) never appear in the chain the app sees.
- `X-Real-IP` matches the leftmost (client) hop.
- `TRUST_PROXY=0`: Express `req.ip` is the private/CGNAT socket, not the
  client, and rotates. `req.ips` is empty.
- `TRUST_PROXY=1`: Express `req.ip` is the **rightmost Railway edge**,
  not the client, and rotates. Unsafe as a limiter key.
- `TRUST_PROXY=2`: Express `req.ip` is the **leftmost client**. Spoofed
  `X-Forwarded-For` / `X-Real-IP` cannot rotate that identity because
  Railway overwrote them before Express ran.

Credential limiter (20 / 15 min, keyed on `req.ip`): from one client,
rotating fake `X-Forwarded-For` values consumed the **same** bucket;
request 20+ returned `429 RATE_LIMITED`. A Cloudflare Worker egress
client received `401` on the same path, not `429` (different network,
different bucket).

Re-probe if the HTTP topology changes (Cloudflare in front of Railway,
multiple hops, or a different region). Do not add a permanent public
endpoint that returns forwarding headers.

## Frontend (Cloudflare Workers Static Assets)

Config: `frontend/wrangler.json`.

- SPA fallback: `assets.not_found_handling = single-page-application` so
  `/account`, `/homes/:homeId/...`, `/invitations/...` serve `index.html`
- Build: `npm ci` then `npm run build --workspace=@roomies/frontend`
- `VITE_API_ORIGIN` is required for deployed builds (no localhost fallback)
- No secret Vite variables
- Source maps: **off** in production (`build.sourcemap: false`)
- Hashed `/assets/*`: `Cache-Control: public, max-age=31536000, immutable`
  (VERIFIED LIVE on Cloudflare Workers Static Assets: the document
  `/* must-revalidate` rule is also concatenated onto `/assets/*`, so the
  live header contains both directives)
- HTML: `public, max-age=0, must-revalidate`
- Document CSP is generated into `dist/_headers` at build time
- No service worker / offline cache
- Do not cache authenticated API responses at Cloudflare (backend already
  sends `no-store` on private JSON)

Cloudflare build environment: Node 24, set `VITE_API_ORIGIN` to the API
origin. Optional `VITE_RELEASE_SHA` is not used; backend `/health` carries the
release SHA for ops.

### Document CSP

Self-hosted scripts, styles, and `@fontsource/manrope` fonts. Images: `'self'`
and `data:`. `connect-src` is `'self'` plus the exact `VITE_API_ORIGIN`. No
`unsafe-eval`, no host wildcards. API Helmet CSP stays disabled (JSON API).

## Environment matrix

Never commit real secrets. Values below are names only.

### Backend

| Variable                      | Local                      | CI           | Preview / staging                                | Production                                          | Class                        |
| ----------------------------- | -------------------------- | ------------ | ------------------------------------------------ | --------------------------------------------------- | ---------------------------- |
| `APP_ENV`                     | `development`              | `test`       | `preview` / `staging`                            | `production`                                        | required                     |
| `PORT`                        | `3000`                     | n/a          | platform                                         | platform (`PORT`)                                   | optional / platform-provided |
| `PROCESS_MODE`                | default `combined`         | n/a          | `combined`                                       | `combined`                                          | optional (default)           |
| `RECURRENCE_POLL_INTERVAL_MS` | default `30000`            | n/a          | default                                          | default                                             | optional                     |
| `DATABASE_URL`                | Compose Postgres           | CI Postgres  | **non-prod Neon**                                | **prod Neon pooled**                                | required                     |
| `AUTH_SECRET`                 | local placeholder replaced | CI-only      | distinct                                         | distinct                                            | required                     |
| `AUTH_BASE_URL`               | default localhost          | CI localhost | HTTPS API origin                                 | HTTPS API origin                                    | required outside local       |
| `FRONTEND_ORIGIN`             | default localhost          | n/a          | HTTPS frontend                                   | HTTPS frontend                                      | required outside local       |
| `TRUSTED_ORIGINS`             | default localhost          | n/a          | exact HTTPS list including `FRONTEND_ORIGIN`     | same                                                | required outside local       |
| `TRUST_PROXY`                 | default `0`                | default `0`  | Railway `us-west2` edge: **`2`** (VERIFIED LIVE) | same Railway topology: `2`; re-probe if hops change | optional (default 0)         |
| `RELEASE_SHA`                 | unset                      | unset        | optional                                         | optional (else Railway SHA)                         | optional                     |
| `RAILWAY_GIT_COMMIT_SHA`      | n/a                        | n/a          | platform                                         | platform                                            | platform-provided            |

### Frontend (public)

| Variable          | Local                           | CI                         | Preview / staging | Production       | Class                        |
| ----------------- | ------------------------------- | -------------------------- | ----------------- | ---------------- | ---------------------------- |
| `VITE_API_ORIGIN` | default `http://localhost:3000` | `https://api.example.test` | HTTPS API origin  | HTTPS API origin | required for deployed builds |

### Release-only

| Variable                 | Purpose                                      | Class                                           |
| ------------------------ | -------------------------------------------- | ----------------------------------------------- |
| `MIGRATION_DATABASE_URL` | Neon **direct** URL for `db:migrate:release` | required for preview/staging/production migrate |

`TEST_DATABASE_URL` is local/CI test tooling only. Never point it at Neon.

## Staging / preview isolation

- Separate Neon databases from production. Never copy production data into
  preview.
- Distinct `AUTH_SECRET` per environment.
- Environment-specific `AUTH_BASE_URL`, `FRONTEND_ORIGIN`, `TRUSTED_ORIGINS`,
  and `VITE_API_ORIGIN`.
- Preview must not use production `DATABASE_URL`.

Do not provision those branches in this ticket.

## Observability

Keep structured, content-free logs, request IDs (`x-request-id`), and the
optional release SHA on probes. Do not log cookies, Authorization, emails,
invitation secrets, or Maintenance bodies. Better Stack is a later M9 hook.
No session replay.

## R2

Not in M9.2. No upload endpoints and no production R2 variables yet.

## Backups (later M9)

Not automated here. Frozen future target:

- Neon practical PITR
- Daily snapshots ~14 days
- Weekly encrypted external `pg_dump` ~4 copies
- Restore drills

## Rollback

Database migrations are not reversed automatically. Roll back application
artifacts (Railway deployment / Cloudflare assets) only when the schema remains
expand-contract compatible. A failed migrate stops the release before new
application code ships.

## M9.3 staging facts (VERIFIED LIVE unless noted)

Isolated non-production only. Railway also created an unused environment
literally named `production` with **zero** services; do not use it.

| Item          | Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Neon          | Project `roomies-staging`, region `aws-us-west-2`, Postgres 18, db `roomies`. Pooled runtime URL and direct migrate URL both connect with `sslmode=require`. Same owner role for both.                                                                                                                                                                                                                                                                                                  |
| Migrate       | `npm run db:migrate:release` with `MIGRATION_DATABASE_URL` (direct). 13 committed migrations applied; `db verify --strict` succeeded. No `db push`, no startup migrate. On Windows, Prisma must be spawned as `node prisma.js` with `shell: false` so `&channel_binding` is not treated as a cmd separator.                                                                                                                                                                             |
| Railway       | Project `roomies-staging`, environment `staging`, service `roomies-api`, region **`us-west2`**, **1** replica, `sleepApplication: false`, healthcheck **`/ready`** (timeout 300s). Builder Railpack. Build `npm run build --workspace=@roomies/backend`. Start `npm run start:prod --workspace=@roomies/backend`. `PROCESS_MODE=combined`. No pre-deploy migrate.                                                                                                                       |
| Node          | **CONFIGURED/EXPECTED:** `engines.node` `>=24 <25`; Railpack reads it. Container `node -v` was not SSH-confirmed.                                                                                                                                                                                                                                                                                                                                                                       |
| Readiness     | `/health` 200 and `/ready` 200 with release SHA. Repeated Prisma `connect()` against Neon pooled/PgBouncer is not a reliable probe; runtime uses the process-owned `pg.Pool` `SELECT 1`.                                                                                                                                                                                                                                                                                                |
| Cloudflare    | Worker `roomies-frontend-staging`, origin `https://roomies-frontend-staging.alexandra-nadine-lewis.workers.dev`. SPA fallback serves `/`, `/account`, `/invitations/...`. CSP present, no `unsafe-eval`, no host wildcards, `connect-src` exact API origin. Source maps absent. HTML `Cache-Control: public, max-age=0, must-revalidate`. Hashed `/assets/*` include `immutable` **and** also inherit the document `must-revalidate` rule (Cloudflare concatenates `/*` + `/assets/*`). |
| Cookies       | API `Set-Cookie`: `__Secure-better-auth.session_token`, `HttpOnly`, `Secure`, `SameSite=Lax`, host-only (no `Domain=`). Operator `Cookie` header reaches `/api/v1/me`. A browser document on `workers.dev` **does not** store/send that cookie to `railway.app` (cross-site / third-party). Production must use same-site hostnames (`roomies.example` + `api.roomies.example`). Do not weaken SameSite to make staging browsers work.                                                  |
| CORS / Origin | Trusted staging frontend: `ACAO` exact origin + credentials. Hostile origin: no `ACAO`. `/api/v1` mutations: missing/hostile Origin → `403 FORBIDDEN`.                                                                                                                                                                                                                                                                                                                                  |
| Worker/outbox | Combined process drained staging outbox (`processed_at` set, no dead rows). Activity projections created. No payload/content in outbox logs.                                                                                                                                                                                                                                                                                                                                            |
| Invitations   | Create works without a mailer (`inviteUrl` returned once). Accept requires Better Auth `email_verified`. October has no mailer; staging isolation used an operator `email_verified=true` patch on a disposable identity only.                                                                                                                                                                                                                                                           |

## Remaining M9 steps

- Same-site production DNS (not `workers.dev` + `railway.app`)
- Production Neon / Railway / Cloudflare environments (separate from staging)
- Protected production promotion workflow
- R2 media
- Backup/PITR validation
- Better Stack
