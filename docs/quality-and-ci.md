# Quality gates, CI, and test databases

Concise operator notes for Roomies foundation quality and verification.

## Dependency installation

Root `npm install` / `npm ci` automatically runs `npm ci` for the deliberately
non-workspace `backend/auth-runtime` package. Both lockfiles are authoritative.
The small lifecycle wrapper clears inherited npm lifecycle metadata before the
nested install; this prevents npm from treating the package as part of its
parent workspace and recursively invoking the root lifecycle.

## Fast local quality (`npm run check`)

From the monorepo root:

```bash
npm run check
```

Runs, in order:

1. `format:check`
2. `lint`
3. `check:boundaries` (import-layer guards)
4. `check:ci-secrets` (workflows must not require repo secrets / local `.env`)
5. `typecheck`
6. workspace unit/component tests
7. frontend production build

This suite does **not** start PostgreSQL, apply migrations, or launch Playwright. Use it for fast iteration.

## Database / migration verification

Offline artifact integrity (no database):

```bash
npm run db:migration:check
```

Uses Prisma’s `migration check` — validates committed package hashes, manifests, and graph connectivity. That is the migration-artifact integrity guard (no custom hash framework).

Fresh empty test database apply + contract verify:

```bash
# Requires Docker Compose Postgres (npm run db:up) and a dedicated test DB.
# Example once:
#   docker compose exec roomies-postgres \
#     psql -U roomies -d roomies -c 'CREATE DATABASE roomies_test;'
#
# Prefer TEST_DATABASE_URL so local `roomies` is never the migrate target:
export TEST_DATABASE_URL=postgresql://roomies:roomies_dev_only@127.0.0.1:5432/roomies_test
npm run db:test:migrate
```

`db:test:migrate` will **refuse** non-test database names and managed/production-looking hosts. It does not `db sign` an empty contract before the initial `from: null` migration, and does not delete markers.

## Browser foundation tests

```bash
npm run test:browser:install --workspace=@roomies/frontend   # once
npm run test:browser
```

Playwright starts the Vite **dev** server so `/__dev/ui` is available. Production builds continue to exclude that route (see frontend router + unit tests). Chromium only; viewports 360 / 390 / 768 / 1280. Axe scans fail CI on serious/critical findings. Screenshots are captured on failure only — no golden-image suite.

## CI overview

GitHub Actions workflow: `.github/workflows/ci.yml` (pull requests + `main`).

- Node 24 + root `npm ci`, including the isolated auth-runtime lockfile
- Format, lint, boundaries, typecheck, backend/frontend tests, frontend production build
- PostgreSQL 18 service with empty `roomies_ci` database → `db:test:migrate`
- Playwright + Axe against the Vite dev server
- No repository secrets, no Neon/production, no deploy steps
- Workflow permissions: `contents: read`

Dependabot: `.github/dependabot.yml` (both npm lockfiles weekly, Actions
monthly). Prisma RC packages are ignored so upgrades stay reviewed; the Better
Auth graph is tracked separately.

## Test-database safety

Destructive helpers (`assertSafeTestDatabase`) require:

- local / Compose / CI hosts only (not Neon or other managed prod hosts)
- database name matching `*_test`, `*_ci`, `roomies_test`, or `roomies_ci`
- `APP_ENV` must not be `production` or `staging`

Prefer `TEST_DATABASE_URL` over `DATABASE_URL` for test tooling. Parallel destructive resets are not supported yet — keep one logical test database or use transactions in future suites.

## Architecture boundaries

`npm run check:boundaries` scans imports so frontend/backend/shared stay separated and Prisma stays out of frontend/shared. Domain repository cross-imports are reserved for future modules.

## Secrets / env hygiene

- `.env` is gitignored; commit only `.env.example` placeholders
- Frontend Vite env is public (`VITE_API_ORIGIN` only) — never put secrets there
- `npm run check:ci-secrets` fails if workflows reference repository secrets or load `.env`
