# Roomies

Roomies is a full-stack roommate and home-coordination web application. Implementation starts from a frozen architecture; the earlier design prototype was removed and remains in Git history only.

## Workspace layout

```
roomies/
├── frontend/   # React web client
├── backend/    # Node/Express modular monolith (+ Prisma 8 persistence)
├── shared/     # Shared HTTP contracts/types only (intentionally small)
└── docs/       # Architecture and implementation documentation
```

npm workspaces link `frontend`, `backend`, and `shared`. Prefer this simple layout over heavier monorepo tooling.

## Install

```bash
npm install
```

Requires Node.js 24+ and npm 10+.

## Local PostgreSQL

Roomies uses real PostgreSQL for local development (major version **18**). Production will use Neon; that is configured separately.

**Prerequisites:** Docker Engine with Compose v2 (`docker compose`).

1. Copy the environment example (credentials are local-dev only):

   ```bash
   cp .env.example .env
   ```

2. Start the database:

   ```bash
   npm run db:up
   ```

   Equivalent: `docker compose up -d`

3. Confirm health:

   ```bash
   docker compose ps
   ```

   The `roomies-postgres` service should report healthy. Connection string (same as `.env.example`):

   `postgresql://roomies:roomies_dev_only@127.0.0.1:5432/roomies`

4. Stop the database (named volume `roomies_pgdata` is kept; data survives restarts and `db:down`):

   ```bash
   npm run db:down
   ```

5. Follow logs when needed:

   ```bash
   npm run db:logs
   ```

| Setting             | Value                                    |
| ------------------- | ---------------------------------------- |
| Image               | `postgres:18`                            |
| Service / container | `roomies-postgres`                       |
| Database            | `roomies`                                |
| User / password     | `roomies` / `roomies_dev_only`           |
| Host port           | `127.0.0.1:5432`                         |
| Volume              | `roomies_pgdata` → `/var/lib/postgresql` |

## Prisma 8 (backend persistence)

Prisma 8 owns the database contract and reviewed migration workflow inside `@roomies/backend`. `shared/` stays environment-neutral and does not import Prisma.

| Piece               | Location                                            |
| ------------------- | --------------------------------------------------- |
| Config              | `backend/prisma.config.ts`                          |
| Contract source     | `backend/src/prisma/contract.prisma` (PSL)          |
| Generated artifacts | `backend/src/prisma/contract.json`, `contract.d.ts` |
| Runtime client      | `backend/src/prisma/db.ts`                          |
| Migrations          | `backend/migrations/` (`app/`, `snapshots/`)        |

Connection uses `DATABASE_URL` from the environment. Prisma CLI loads it via `backend/prisma.config.ts`. Application runtime validates env through `backend/src/platform/config/` (`APP_ENV`, `PORT`, `TRUSTED_ORIGINS`, `DATABASE_URL`) and passes the typed URL into `createDb`. Do not hardcode credentials.

### Fresh-database bootstrap note

On a brand-new empty database, do **not** `db sign` the empty emitted contract before applying the initial `from: null` migration. The initial reviewed migration establishes the first real marker/ref. See `backend/migrations/README.md`.

### Prisma 8 RC version policy

Prisma 8 is intentionally adopted during its release-candidate period. Until Prisma 8 stable:

- Pin `prisma` and `@prisma/orm-postgres` to **exact** versions (no `^` / `~`).
- Treat RC upgrades as explicit, reviewed dependency changes — do not bump merely because a newer RC exists.
- Review migration and contract emit/verify behavior before accepting an RC upgrade.
- Do not rely on production dependency automation to silently advance Prisma RC versions.

The lockfile plus exact pins are the control mechanism; no extra tooling is required for this. CLI and ORM package RC suffixes may differ; keep the currently validated pair unless a reviewed upgrade changes both intentionally.

### Reviewed migration workflow

1. **Modify the contract** — edit `backend/src/prisma/contract.prisma`.
2. **Emit the contract** — `npm run db:contract:emit` (or `npm run contract:emit --workspace=@roomies/backend`). Offline; refreshes generated artifacts.
3. **Plan a migration** — `npm run db:migration:plan -- --name <slug>` (or backend `migration:plan`). Offline; writes a package under `backend/migrations/app/`.
4. **Inspect / review the migration** — read `migration.ts`, `ops.json`, and the DDL preview before merging.
5. **Apply the migration** — `npm run db:migrate` (**mutates the database**).
6. **Verify the database** — `npm run db:verify` (compares marker + live schema to the emitted contract).

Roomies does **not** use the Prisma 7 `migrate dev` workflow, and does **not** use `db push` / direct reconciliation as the normal migration path. Future schema changes go through reviewed `migration plan` artifacts.

Useful non-mutating checks:

- `npm run db:verify --workspace=@roomies/backend -- --schema-only` — connect and check schema against the contract without requiring a Prisma marker (from the monorepo root, use `npm run db:verify -- -- --schema-only` so the flag survives the nested workspace script).
- `npx prisma db schema` (from `backend/`) — read-only live schema inspection.

Signing / initializing Prisma’s database marker (`db sign`, `db init`) writes Prisma metadata and should be reviewed before first use on a shared database.
