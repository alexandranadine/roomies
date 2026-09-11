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
