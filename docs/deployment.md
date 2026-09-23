# Deployment (M9.2 / M9.3 / M9.4)

M9.2 prepared the repository. M9.3 created an isolated **staging**
deployment and recorded live platform facts below. M9.4 made the
repository production-ready for domain, email verification, and
infrastructure provisioning. **M9.5 owns actual production resources.**

Production hostnames are **operator-supplied**. This repository does not
invent, purchase, or configure a Roomies domain. Until the operator
selects one, use this same-site shape on **one registrable domain**:

- Frontend: `https://<production-site-host>`
- API: `https://<production-api-host>`

Preferred example shape (not a real registration):

- Frontend: `https://roomies.example`
- API: `https://api.roomies.example`

Staging uses provider hostnames only (`*.up.railway.app`, `*.workers.dev`).
Those origins are **not** production and are **not** same-site.

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
silently run Node 22/25. Production runtime **fails fast** if
`process.versions.node` major is not `24`. Staging/preview log
`[process] node <version>` at boot (no public diagnostic endpoint).

## Production domain contract (operator-supplied)

Do not configure DNS in this ticket. M9.5 / the operator must provide:

| Item                        | Production requirement                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| Frontend origin             | `https://<production-site-host>` (`FRONTEND_ORIGIN`, Cloudflare Worker custom domain)       |
| API origin                  | `https://<production-api-host>` (`AUTH_BASE_URL`, `VITE_API_ORIGIN`, Railway custom domain) |
| Registrable site            | Frontend and API **must be same-site** (e.g. `roomies.example` + `api.roomies.example`)     |
| DNS ownership/provider      | Operator-owned zone (not invented here)                                                     |
| TLS                         | Cloudflare (frontend) and Railway (API) terminate TLS on the custom hostnames               |
| Better Auth `AUTH_BASE_URL` | Exact API HTTPS origin                                                                      |
| `TRUSTED_ORIGINS`           | Exact frontend origin (include `FRONTEND_ORIGIN`)                                           |
| Cookie model                | Unchanged: `HttpOnly`, `Secure`, `SameSite=Lax`, **host-only** (no `Domain=`)               |

Production config **rejects** cross-site pairs such as `*.workers.dev` +
`*.railway.app` or an unrelated `FRONTEND_ORIGIN`. Staging may still use
provider hostnames.

### Cookie production proof (after custom hostnames exist)

From the real frontend custom hostname in a browser:

1. Sign up / sign in
2. API `Set-Cookie` is `__Secure-better-auth.session_token`
3. Attributes: `Secure`, `HttpOnly`, `SameSite=Lax`, host-only (no `Domain`)
4. Browser stores the cookie for the **API hostname**
5. Credentialed frontend `fetch` sends it
6. `GET /api/v1/me` returns 200
7. Unrelated external origin: no credentialed CORS (`ACAO` withheld)
8. `/api/v1` mutation with hostile Origin: `403 FORBIDDEN`

Do not weaken cookies to make staging provider domains work.

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

**TRUST_PROXY production rule:** `2` is valid **only** for
`client → Railway public edge → app`. If the production API custom
hostname maps **directly** to Railway with no Cloudflare proxy/CDN in
front, M9.5 must re-run a small spoof probe and may reuse `2` if the
chain still matches. If Cloudflare (or any extra proxy) is placed in
front of Railway, do **not** retune `TRUST_PROXY` to pick a client IP.
Set `INGRESS_MODE=cloudflare` and `CLOUDFLARE_ORIGIN_AUTH_SECRET`
instead. Limiter identity then comes from authenticated
`CF-Connecting-IP`, not Express `req.ip`. Keep the existing hop count.
Do not ship a permanent public forwarding-header diagnostic.

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

## Cloudflare origin authentication (production API)

Production visitor path: `visitor → Cloudflare → Railway → Express`.
Do **not** infer this from `APP_ENV`. Configure it explicitly:

| Variable                        | Production value                                          | Class    |
| ------------------------------- | --------------------------------------------------------- | -------- |
| `INGRESS_MODE`                  | `cloudflare`                                              | required |
| `CLOUDFLARE_ORIGIN_AUTH_SECRET` | high-entropy random secret, ≥32 characters                | secret   |
| `TRUST_PROXY`                   | leave unchanged (Railway hop count; not limiter identity) | optional |

The backend requires Cloudflare to **overwrite** (not append) a dedicated
request header on every request to the API hostname:

- Header name: `X-Roomies-Origin-Auth`
- Header value: the same secret as Railway `CLOUDFLARE_ORIGIN_AUTH_SECRET`

After that match succeeds, the backend trusts `CF-Connecting-IP` only when
it occurs exactly once and contains exactly one IPv4 or IPv6 address.
Missing/wrong/duplicate origin-auth or a missing/invalid/duplicate
`CF-Connecting-IP` fails closed (`403 FORBIDDEN`) before credential,
invitation, and product handlers. Direct Railway ingress without the
header cannot reach those handlers.

`GET /health` and `GET /ready` stay available without the secret so
Railway health checks continue to work. Those exemptions do not store a
trusted client identity.

Do not configure Authenticated Origin Pulls as a substitute for this
header. Do not trust Host, Origin, XFF, X-Real-IP, or the TCP peer as
Cloudflare provenance.

### Production ingress verification (VERIFIED LIVE)

Observed on the production API. This record does not include secrets, raw
client IPs, or diagnostic hashes.

- Cloudflare origin-auth overwrite is verified.
- Authenticated Cloudflare ingress succeeded.
- Trusted limiter identity matched `CF-Connecting-IP`.
- Trusted limiter identity did not match `X-Forwarded-For`
  intermediaries.
- Client-supplied `X-Forwarded-For` and `X-Real-IP` did not rotate
  limiter identity.
- Client-supplied `X-Roomies-Origin-Auth` was overwritten by Cloudflare.
- A client attempt to supply `CF-Connecting-IP` was rejected at the
  Cloudflare edge with Cloudflare error 1000 before reaching the
  application.
- No Railway-generated public `*.up.railway.app` hostname is currently
  enabled. Only `api.roomies.casa` is publicly configured, plus the
  private `roomies.railway.internal` endpoint.
- The temporary production IP diagnostic was removed after verification.
  `IP_PROBE_TOKEN` was removed from Railway and must not be reintroduced.

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

| Variable                        | Local                      | CI               | Preview / staging                                | Production                                               | Class                        |
| ------------------------------- | -------------------------- | ---------------- | ------------------------------------------------ | -------------------------------------------------------- | ---------------------------- |
| `APP_ENV`                       | `development`              | `test`           | `preview` / `staging`                            | `production`                                             | required                     |
| `PORT`                          | `3000`                     | n/a              | platform                                         | platform (`PORT`)                                        | optional / platform-provided |
| `PROCESS_MODE`                  | default `combined`         | n/a              | `combined`                                       | `combined`                                               | optional (default)           |
| `RECURRENCE_POLL_INTERVAL_MS`   | default `30000`            | n/a              | default                                          | default                                                  | optional                     |
| `DATABASE_URL`                  | Compose Postgres           | CI Postgres      | **non-prod Neon**                                | **prod Neon pooled**                                     | required                     |
| `AUTH_SECRET`                   | local placeholder replaced | CI-only          | distinct                                         | distinct                                                 | required                     |
| `AUTH_BASE_URL`                 | default localhost          | CI localhost     | HTTPS API origin                                 | HTTPS API origin                                         | required outside local       |
| `FRONTEND_ORIGIN`               | default localhost          | n/a              | HTTPS frontend                                   | HTTPS frontend                                           | required outside local       |
| `TRUSTED_ORIGINS`               | default localhost          | n/a              | exact HTTPS list including `FRONTEND_ORIGIN`     | same                                                     | required outside local       |
| `TRUST_PROXY`                   | default `0`                | default `0`      | Railway `us-west2` edge: **`2`** (VERIFIED LIVE) | keep Railway hop count; **do not** retune for Cloudflare | optional (default 0)         |
| `INGRESS_MODE`                  | default `direct`           | default `direct` | `direct` unless Cloudflare proxies the API       | **`cloudflare`** when Cloudflare proxies the API         | optional (default `direct`)  |
| `CLOUDFLARE_ORIGIN_AUTH_SECRET` | unset                      | unset            | unset when `direct`                              | required when `INGRESS_MODE=cloudflare`                  | secret                       |
| `RELEASE_SHA`                   | unset                      | unset            | optional                                         | optional (else Railway SHA)                              | optional                     |
| `RAILWAY_GIT_COMMIT_SHA`        | n/a                        | n/a              | platform                                         | platform                                                 | platform-provided            |
| `EMAIL_PROVIDER`                | default `fake`             | default `fake`   | required (`resend` or explicit `fake`)           | **`resend` only** (fake rejected)                        | required outside local       |
| `EMAIL_API_KEY`                 | n/a for fake               | n/a for fake     | required for `resend`                            | required                                                 | secret                       |
| `EMAIL_FROM`                    | n/a for fake               | n/a for fake     | required for `resend`                            | required (`Roomies <noreply@<sending-domain>>`)          | required for resend          |

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
| Invitations   | Create works without a product invitation mailer (`inviteUrl` returned once). Accept requires Better Auth `email_verified`. Verification mail uses the transactional adapter (staging may set `EMAIL_PROVIDER=fake` until a sending domain exists). Do not DB-patch `email_verified` for the production proof path.                                                                                                                                                                     |

## Email verification (M9.4)

October transactional mail is **email verification only** (invitation
acceptance). Password-reset delivery is **not** wired. No newsletters,
product notifications, or invitation emails.

Provider: **Resend** (HTTPS API, verified sending domain, secret API
key, no SMTP password in the repo). The application uses `fetch` to
`https://api.resend.com/emails`. No Resend SDK. No provider types in
`shared/` or domain packages.

`TransactionalEmailSender.sendVerificationEmail` is the only send
surface. Better Auth's `emailVerification.sendVerificationEmail` hook
is the integration point. Tokens remain Better Auth JWTs (`expiresIn`
3600 seconds / 1 hour). `requireEmailVerification` stays **false** so
ordinary Roomies use does not require a verified inbox; **invitation
acceptance** still requires `email_verified`.

Signup can send a verification email (`sendOnSignUp`). The invitation
landing page can resend for a signed-in unverified session.
`POST /api/auth/send-verification-email` stays on the M9.1 credential
limiter (IP key, not email). Unauthenticated Better Auth resend already
returns a generic success for missing/already-verified addresses.
Provider outage on a real unverified address can surface as 500 vs 200;
the product resend path is session-authenticated.

Delivery failure: do not claim the email was sent. HTTP maps to
`500 INTERNAL_ERROR` without provider bodies, emails, tokens, or URLs.
Logs are `[email] verification delivery failed` only.

Verification links use Better Auth's URL with `callbackURL` forced to
`${FRONTEND_ORIGIN}/verify-email`. GET `/api/auth/verify-email`
`originCheck` rejects callbacks outside `TRUSTED_ORIGINS`.

### Sending-domain plan (M9.5 / operator)

Do not fabricate provider DNS records before an account and domain
exist. After Resend + the production zone exist:

- Verify the sending domain in Resend
- Publish the provider's **SPF** TXT on the sending domain
- Publish the provider's **DKIM** CNAMEs/TXT as instructed
- Publish a **DMARC** TXT (`v=DMARC1; p=quarantine` is a reasonable
  starting policy for a small transactional app; tighten later)
- `EMAIL_FROM` like `Roomies <noreply@mail.<production-site-host>>`
  or the provider-recommended subdomain

## M9.5 production provisioning checklist

Do **not** create these in M9.4.

**Neon**

- Region: `aws-us-west-2` (match staging / Railway US West)
- Tier: Launch if PITR/backup expectations require it
- Pooled runtime `DATABASE_URL` (`sslmode=require`)
- Direct `MIGRATION_DATABASE_URL` (no `-pooler`)
- PITR expectation: practical Neon PITR (later backup ticket still applies)
- Distinct production credentials; never reuse staging

**Railway**

- Region `us-west2`
- Exactly 1 replica
- Auto-sleep **OFF**
- Combined `PROCESS_MODE`
- Healthcheck `/ready`
- Node 24 (Railpack `engines.node` + boot assertion)
- Exact `RELEASE_SHA`
- `TRUST_PROXY=2` only if topology remains direct-to-Railway; with Cloudflare in front, keep the hop count and set `INGRESS_MODE=cloudflare` instead
- `INGRESS_MODE=cloudflare`
- `CLOUDFLARE_ORIGIN_AUTH_SECRET` (high-entropy; never in git)
- Custom API hostname

**Cloudflare**

- Workers Static Assets
- Custom frontend hostname
- `VITE_API_ORIGIN` exact API origin
- Document CSP `connect-src` exact API hostname
- SPA fallback
- Cache headers as staging
- API hostname proxied through Cloudflare
- HTTP Request Header Modification rule: **overwrite** `X-Roomies-Origin-Auth` on all methods to the API origin with the Railway origin-auth secret (do not append; do not pass through a client value)

**Email**

- Resend account
- Sending domain verified
- API secret in Railway (not Vite, not git)
- From address

**GitHub**

- Protected production environment
- Required release secrets in that environment only
- No push-to-main production deployment (`check:ci-secrets` still forbids
  workflow secret coupling for CI)

## Remaining M9 steps

- Operator selects the production registrable domain
- Same-site production DNS (not `workers.dev` + `railway.app`)
- Production Neon / Railway / Cloudflare environments (separate from staging)
- Resend account + sending-domain DNS (SPF/DKIM/DMARC)
- Protected production promotion workflow
- R2 media
- Backup/PITR validation
- Better Stack
