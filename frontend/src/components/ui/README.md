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

Overlay behavior (provided by Base UI, covered by unit/e2e tests):

- **Dialog / Sheet:** modal focus trap, Escape dismiss, backdrop/outside click dismiss (default `disablePointerDismissal: false`), focus restore to trigger on Escape, and page scroll lock via Base UI (`overflow: hidden` on the viewport scroller; may also set `data-base-ui-scroll-locked` on `<html>` depending on browser). Pointer dismiss closes the dialog but does not restore trigger focus — that is Base UI’s default; Escape is the keyboard path that returns focus.
- **Menu:** keyboard navigation, Escape close, and focus return to the trigger.

## Icons

**`@heroicons/react`** — import icons directly where needed; there is no Roomies icon wrapper layer. Use the official React packages and pick the family intentionally:

| Package | Use |
| ------- | --- |
| `@heroicons/react/24/outline` | Standard/default UI icons; inactive navigation |
| `@heroicons/react/24/solid` | Active navigation; stronger emphasis |
| `@heroicons/react/20/solid` | Compact cards, event bubbles, menus, statuses |
| `@heroicons/react/16/solid` | Tiny metadata, chevrons, compact status indicators |

Conventions:

- Icons inherit `currentColor` — style with semantic text/color utilities, not hardcoded fills.
- Decorative SVGs: `aria-hidden="true"`.
- Icon-only controls: an explicit accessible name on the button/link (do not rely on SVG titles).
- Active nav: outline when inactive, solid when active — but text treatment and `aria-current` remain the primary active-state cues; icon fill alone must not communicate selection.

## Class composition

**`clsx`** via the local `cn()` helper. No `class-variance-authority` (or similar) yet — variant maps stay small and local to each component.

## Development fixture

In development, open `/__dev/ui` to inspect primitive variants, focus, and mobile widths.

The route is registered only when `includeDevRoutes` is true (default: `import.meta.env.DEV`). Production builds set `import.meta.env.PROD`, which eliminates the fixture route and its dynamic import from the router graph. The production router has no reachable `/__dev/ui` path.

## Do not

- Encode domain states (for example `TASK_OVERDUE`) into primitives
- Build `PrivacyPanel` / `ProtectedDetails` here
- Add Storybook / Chromatic / visual snapshot SaaS for October scope
