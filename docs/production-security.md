# Production security baseline (M9.1)

HTTP hardening required before exposing the Roomies backend publicly.
This is not a deployment guide. Railway/Neon/Cloudflare stay on later M9
tickets.

## Rate limiting

In-process sliding-window limiter. No Redis. No rate-limit table.

| Class              | Routes                                                                                                                                                                       | Key                                                 | Default         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | --------------- |
| `credential`       | `POST /api/auth/sign-in/email`, `sign-up/email`, `request-password-reset`, `forget-password`, `reset-password`, `send-verification-email`, `change-password`, `change-email` | Trusted client identity (see Ingress below)         | 20 / 15 minutes |
| `sensitive`        | `DELETE /api/v1/account`, `POST /api/v1/homes/:homeId/invitations`                                                                                                           | canonical `userId`                                  | 10 / 15 minutes |
| `invitation_token` | `POST /api/v1/invitations/:id/preview`, `POST /api/v1/invitations/:id/accept`                                                                                                | Trusted client identity (same source as credential) | 30 / 15 minutes |

Rejected requests are `429` with Roomies error code `RATE_LIMITED`, message
`Too many requests`, and `Retry-After` in seconds when the window reset can
be computed. Responses do not include emails, tokens, bucket keys, or
account-existence hints.

Better Auth's built-in limiter is explicitly disabled. Roomies owns the
429 envelope. Session lookup (`GET /api/auth/get-session`), `/api/auth/ok`,
and `POST /api/auth/sign-out` are not credential-throttled.
`GET /health` and `GET /ready` are not limited.

Password reset and email verification **sending** now have a Roomies
transactional adapter (Resend in production, explicit `fake` in
local/test/staging). Better Auth `requireEmailVerification` remains
`false`. Invitation acceptance still requires a verified email.
`POST /api/auth/send-verification-email` (and password-reset paths)
stay credential-limited so they cannot be hammered. Password-reset
**delivery** is still not a product feature.

## Single-instance limitation

The store is process memory. Counts reset on restart. Two backend instances
do not share buckets. Initial October production is one Railway combined
process. Do not scale HTTP replicas until this limiter is replaced with a
centralized implementation. That replacement must keep the same route
classes and 429 contract.

Abandoned buckets are pruned on consume. Production enables a 60s `unref`
sweep so timers do not block graceful shutdown.

Maximum simultaneous keys: 10_000. New attacker-controlled identities fail
closed with 429 once the cap is reached.

## Trusted proxy

`TRUST_PROXY` remains an integer hop count. Default `0` ignores
`X-Forwarded-*`. Boolean `true` is rejected (VERIFIED LIVE on staging
Railway: the process exits at boot and is not promoted). Do not change
`TRUST_PROXY` to fix Cloudflare limiter identity.

### Direct ingress (`INGRESS_MODE=direct`, default)

Unauthenticated limiter identity is Express `req.ip` under that hop count.
`INGRESS_MODE` is never inferred from `APP_ENV`.

**VERIFIED LIVE (M9.3 staging, Railway `us-west2`, `*.up.railway.app`, no
CDN in front):** Railway overwrites client `X-Forwarded-For` and
`X-Real-IP`, then presents exactly two public hops (client, then rotating
Railway edge). `TRUST_PROXY=1` selects the edge (wrong, unstable).
`TRUST_PROXY=2` selects the client and cannot be rotated by spoofed
headers. Credential limiter requests with varying fake `X-Forwarded-For`
shared one bucket; limit+1 returned `429 RATE_LIMITED`. A different
network (Cloudflare Worker egress) did not share that bucket.

Use `TRUST_PROXY=2` for that direct Railway HTTP topology. Re-probe if a
CDN or extra hop is placed in front. Do not ship a permanent public
forwarding-header diagnostic.

Older Railway docs mention `X-Real-IP` without a stable hop count; that
speculation is superseded by the live overwrite + two-hop chain above.

### Cloudflare ingress (`INGRESS_MODE=cloudflare`)

Production visitor path is `visitor → Cloudflare → Railway → Express`.
Limiter identity must **not** use `req.ip` / `TRUST_PROXY` on that path:
`TRUST_PROXY=2` selects an unstable intermediary, not the connecting
client. Keep the existing hop count; do not retune it as a workaround.

Cloudflare provenance is established only by a dedicated overwritten
request header `X-Roomies-Origin-Auth` matching
`CLOUDFLARE_ORIGIN_AUTH_SECRET` (constant-time compare). Host, Origin,
`X-Forwarded-For`, `X-Real-IP`, `CF-Connecting-IP` existence, and
`socket.remoteAddress` are not proof that Cloudflare sent the request.

Only after that origin authentication succeeds does the process trust a
single `CF-Connecting-IP` (exactly one header, exactly one IPv4 or IPv6
address, never a comma-separated list). The validated address is stored
in request-local state and used by `clientNetworkIdentity()`. Missing or
invalid origin auth, or missing/invalid/duplicate `CF-Connecting-IP`,
fails closed (`403 FORBIDDEN`) and never falls back to `req.ip`.

Direct Railway hostname traffic without the origin secret cannot reach
credential, invitation, or product handlers. `GET /health` and
`GET /ready` remain available without the secret for Railway probes and
do not establish a trusted client identity.

`CLOUDFLARE_ORIGIN_AUTH_SECRET` is required at boot when
`INGRESS_MODE=cloudflare` and is redacted like other secrets. Do not set
the secret when `INGRESS_MODE=direct`.

## General API limiter

Not implemented for October. Credential, sensitive, and invitation-token
classes close the M8 launch blocker. The frontend does not poll. Add a
generous authenticated API ceiling if scrape/abuse appears or before
running more than one HTTP instance.

## CORS / Origin / headers / body

Unchanged M8 semantics:

- Exact-origin CORS from `TRUSTED_ORIGINS`; credentials only for those
  origins; no wildcard; unknown Origin is not reflected.
- `/api/v1` mutation Origin guard still rejects missing/untrusted Origin
  with `403 FORBIDDEN` before JSON work.
- JSON body limit remains `32kb`. No urlencoded parser. No uploads.
- API Helmet CSP is disabled (JSON API, not document hosting). Frontend
  origin owns document CSP.
- `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, locked-down `Permissions-Policy`.
- HSTS only when `secureAuthCookies` is true (preview/staging/production).

## Logging

429s are not logged. Unexpected errors remain content-free (`requestId`,
route category, status, error class). Limiter keys, emails, cookies,
Authorization, invitation secrets, and Maintenance content are never
logged.
