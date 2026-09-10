# Roomies

Roomies is a full-stack roommate and home-coordination web application. Implementation starts from a frozen architecture; the earlier design prototype was removed and remains in Git history only.

## Workspace layout

```
roomies/
├── frontend/   # React web client
├── backend/    # Node/Express modular monolith
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

Roomies uses real PostgreSQL for local development (major version **18**). Production will use Neon; that is configured separately. Prisma is not part of this setup yet.

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
