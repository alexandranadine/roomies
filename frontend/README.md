# Roomies frontend

React + Vite application shell for Roomies. Product feature screens are not implemented yet.

## Commands

From the monorepo root:

```bash
npm run dev --workspace=@roomies/frontend
npm run build --workspace=@roomies/frontend
npm run typecheck --workspace=@roomies/frontend
npm run test --workspace=@roomies/frontend
```

Or from `frontend/`:

```bash
npm run dev
npm run build
npm run typecheck
npm run test
```

## Environment

Public Vite env only — **never** put secrets (for example `DATABASE_URL`) in frontend env; they would ship in the client bundle.

| Variable          | Purpose                                           |
| ----------------- | ------------------------------------------------- |
| `VITE_API_ORIGIN` | API origin (`https://host` or `http://host:port`) |

Copy `.env.example` to `.env` for local overrides:

```bash
cp .env.example .env
```

- **Development:** if `VITE_API_ORIGIN` is unset, the app defaults to `http://localhost:3000`.
- **Deployed / production builds:** `VITE_API_ORIGIN` is required. There is no silent localhost fallback. Production assumes separate frontend and API hosts.

## Typography

Manrope (400/500/600/700) is loaded via `@fontsource/manrope` (files served from `node_modules`, not committed as binaries). Self-hosting through the package keeps fonts off a third-party CDN; production CSP still needs to allow the app origin for font files.

## UI primitives

Reusable controls live in `src/components/ui/`. See [`src/components/ui/README.md`](./src/components/ui/README.md) for the headless/icon choices, token expectations, and the development-only `/__dev/ui` fixture.
