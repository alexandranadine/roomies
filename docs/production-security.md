# Production security baseline (M9.1)

HTTP hardening required before exposing the Roomies backend publicly.
This is not a deployment guide. Railway/Neon/Cloudflare stay on later M9
tickets.

## Rate limiting

In-process sliding-window limiter. No Redis. No rate-limit table.

| Class              | Routes                                                                                                                                                                       | Key                                      | Default         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | --------------- |
| `credential`       | `POST /api/auth/sign-in/email`, `sign-up/email`, `request-password-reset`, `forget-password`, `reset-password`, `send-verification-email`, `change-password`, `change-email` | Express `req.ip` (trust-proxy hop count) | 20 / 15 minutes |
| `sensitive`        | `DELETE /api/v1/account`, `POST /api/v1/homes/:homeId/invitations`                                                                                                           | canonical `userId`                       | 10 / 15 minutes |
| `invitation_token` | `POST /api/v1/invitations/:id/preview`, `POST /api/v1/invitations/:id/accept`                                                                                                | Express `req.ip`                         | 30 / 15 minutes |

Rejected requests are `429` with Roomies error code `RATE_LIMITED`, message
`Too many requests`, and `Retry-After` in seconds when the window reset can
be computed. Responses do not include emails, tokens, bucket keys, or
account-existence hints.

Better Auth's built-in limiter is explicitly disabled. Roomies owns the
429 envelope. Session lookup (`GET /api/auth/get-session`), `/api/auth/ok`,
and `POST /api/auth/sign-out` are not credential-throttled.
`GET /health` and `GET /ready` are not limited.

Password reset and email verification **sending** are not product features
yet (`requireEmailVerification: false`, no mailer). Those Better Auth POST
paths still exist and are credential-limited so they cannot be hammered.

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
`X-Forwarded-*`. Boolean `true` is rejected.

Unauthenticated limiter identity is Express `req.ip` under that hop count.
With `TRUST_PROXY=0`, client-supplied `X-Forwarded-For` cannot rotate the
credential bucket. With `TRUST_PROXY=1`, Express uses the rightmost
forwarded address (one hop from the socket).

Railway official docs identify `X-Real-IP` as the client-IP header and do
not publish a stable hop count or `X-Forwarded-For` overwrite contract.
Staff answers disagree on append vs strip and on hop count. Roomies does
**not** guess `TRUST_PROXY=1` as a production default. Set the hop count
only after a deployed probe confirms `req.ip` against known client
addresses. Until that probe, leave `TRUST_PROXY=0` (fail closed: all
clients share the proxy socket identity).

Live-probe procedure (after a private backend exists; M9.3 owns the
diagnostic, which is not a permanent public header dump):

1. Deploy a private/non-public backend with `TRUST_PROXY=0`
2. Hit the dedicated safe diagnostic
3. Observe server-side `req.ip` through Railway
4. Test a controlled `X-Forwarded-For` spoof
5. Determine the exact hop count
6. Set `TRUST_PROXY` to that integer
7. Repeat the spoof test
8. Only then expose production publicly

See [`docs/deployment.md`](deployment.md) for the rest of the deploy contract.

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
