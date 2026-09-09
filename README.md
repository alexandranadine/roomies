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

Requires Node.js 20+ and npm 10+.
