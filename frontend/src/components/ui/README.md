# UI primitives

Reusable interaction primitives for Roomies live in `src/components/ui/`.

They are **design/system controls only** — no Home/Task/Supply domain behavior, no privacy composition, and no feature mock workflows.

## Layout

| Area                         | Path                          |
| ---------------------------- | ----------------------------- |
| Primitives                   | `src/components/ui/`          |
| Barrel export                | `src/components/ui/index.ts`  |
| Dev visual QA fixture        | `src/dev/ui-fixture-page.tsx` |
| Dev fixture route (dev only) | `/__dev/ui`                   |

## Semantic tokens

Style primitives with the frozen Tailwind semantic tokens in `src/styles/tokens.css` (`bg-surface`, `text-text-primary`, `border-border`, `bg-brand`, status/privacy colors, control heights, radii). Prefer those utilities over raw hex.

## Headless library

**`@base-ui/react`** provides accessible behavior for Dialog, Menu, Tabs, Switch, Radio, and Checkbox.

Rationale: React 19–ready, unstyled/headless, modular imports, focus management included — no full visual suite and no hand-rolled modal focus traps.

Sheet is a positioned Dialog variant (same focus foundation), not a second focus system.

## Icons

**`lucide-react`** — tree-shakeable line icons. Import icons directly where needed; there is no Roomies icon wrapper layer.

## Class composition

**`clsx`** via the local `cn()` helper. No `class-variance-authority` (or similar) yet — variant maps stay small and local to each component.

## Development fixture

In development, open `/__dev/ui` to inspect primitive variants, focus, and mobile widths.

The route is registered only when `includeDevRoutes` is true (default: `import.meta.env.DEV`). Production builds set `import.meta.env.PROD`, which eliminates the fixture route and its dynamic import from the router graph. The production router has no reachable `/__dev/ui` path.

## Do not

- Encode domain states (for example `TASK_OVERDUE`) into primitives
- Build `PrivacyPanel` / `ProtectedDetails` here
- Add Storybook / Chromatic / visual snapshot SaaS for October scope
