# Roomies frontend

React + Vite application shell for Roomies. Product feature screens are not implemented yet.

## Commands

From the monorepo root:

```bash
npm run dev --workspace=@roomies/frontend
npm run build --workspace=@roomies/frontend
npm run typecheck --workspace=@roomies/frontend
npm run test --workspace=@roomies/frontend
npm run test:browser --workspace=@roomies/frontend
```

Or from `frontend/`:

```bash
npm run dev
npm run build
npm run typecheck
npm run test
npm run test:browser
```

Browser foundation tests (Playwright + Axe) start the Vite **dev** server so `/__dev/ui` is available. Install Chromium once with `npm run test:browser:install`. Production builds still exclude the fixture route.

## Environment

Public Vite env only — **never** put secrets (for example `DATABASE_URL`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`) in frontend env; they would ship in
the client bundle. `VITE_R2_S3_ORIGIN` is a public origin, not a credential.

| Variable            | Purpose                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| `VITE_API_ORIGIN`   | API origin (`https://host` or `http://host:port`)                                                |
| `VITE_R2_S3_ORIGIN` | Public R2 S3 origin (`https://host`) for `connect-src` and browser PUT/GET to signed object URLs |

Copy `.env.example` to `.env` for local overrides:

```bash
cp .env.example .env
```

- **Development:** if `VITE_API_ORIGIN` is unset, the app defaults to `http://localhost:3000`.
- **Deployed / production builds:** `VITE_API_ORIGIN` is required. There is no silent localhost fallback. Production assumes separate frontend and API hosts.
- **`VITE_R2_S3_ORIGIN`:** optional when unset. When set, it must be an exact origin (no path, wildcard, or credentials). It is added to document CSP `connect-src` only — never `img-src`. Home photos render from local `blob:` URLs.

### Local Home-photo uploads

The backend `fake` object store is an in-process test adapter. It cannot service a real browser’s direct presigned PUT.

- Unit and component tests mock the frontend network flow.
- Playwright may intercept Roomies photo endpoints and the signed R2 PUT/GET.
- Manual real-browser upload requires backend `R2_PROVIDER=cloudflare`, a private dev/staging bucket with CORS for the frontend origin, and a valid `VITE_R2_S3_ORIGIN`. The bucket must not be publicly readable.

Do not add an Express upload proxy, fake public upload server, Worker, MinIO, or multipart/form-data backend upload to make local uploads easier.

Production static hosting is Cloudflare Workers Static Assets (`wrangler.json`). Direct navigation to `/account`, `/homes/:id`, and `/invitations/:id` uses the SPA `not_found_handling` fallback. Document CSP and cache headers are written to `dist/_headers` at build time. Source maps are not emitted. See [`docs/deployment.md`](../docs/deployment.md).

## Typography

Manrope (400/500/600/700) is loaded via `@fontsource/manrope` (files served from `node_modules`, not committed as binaries). Self-hosting through the package keeps fonts off a third-party CDN; production CSP still needs to allow the app origin for font files.

## UI primitives

Reusable controls live in `src/components/ui/`. See [`src/components/ui/README.md`](./src/components/ui/README.md) for the headless/icon choices, token expectations, and the development-only `/__dev/ui` fixture.
