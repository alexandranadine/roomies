# Prisma 8 migration packages

Reviewed migration artifacts for `@roomies/backend` live here.

Expected layout (created by `prisma migration plan`, not by hand):

```
migrations/
├── app/                 # application-space migration packages
│   └── <timestamp>_<slug>/
│       ├── migration.ts
│       ├── ops.json
│       └── migration.json
└── snapshots/           # contract snapshots referenced by migrations
    └── <contract-hash>/
        ├── contract.json
        └── contract.d.ts
```

Do not invent placeholder domain migrations. Plan packages only after a deliberate contract change, then review before `db migrate`.

## Fresh-database bootstrap

For a **brand-new empty** Roomies database:

1. Emit the contract and ensure the initial reviewed `from: null` migration package exists.
2. Apply that initial migration (and advance the canonical `db` ref as part of the reviewed apply path).
3. The initial migration establishes the first real marker/ref.

Do **not** `db sign` the empty emitted contract before applying the initial `from: null` migration graph. `db sign` is not part of the normal fresh-database bootstrap before the initial migration.

Manual marker deletion is **not** the standard workflow. Marker deletion during local experimental bootstrap was recovery from an orphan pre-migration marker, not the production procedure.

## Integrity checks

`npm run db:migration:check` (Prisma `migration check`) is the automated guard for committed migration artifacts. It is offline and verifies:

- package internal consistency (hashes match attested contents)
- manifests are complete
- graph edges connect and refs point at valid nodes

CI also applies the same committed graph to a fresh empty `roomies_ci` database and runs `prisma db verify --strict`. Do not invent a parallel custom hash/crypto framework.

## Fresh test / CI database

Use a dedicated database (`roomies_test` locally, `roomies_ci` in GitHub Actions). Prefer `TEST_DATABASE_URL`. See `docs/quality-and-ci.md` and `backend/scripts/verify-fresh-migrations.ts`.
