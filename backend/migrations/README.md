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
