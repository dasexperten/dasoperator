# Mobile UI — Das Operator default chrome

**Status:** Canonical · approved by owner 2026-07-13  
**Repos:** `dasoperator` (`web/app/globals.css`, `web/components/layout/mobile-shell.tsx`)  
**Visual source of truth:** [das-dashboard.md](./das-dashboard.md) (AI Crawlers / command-center pattern)  
**Breakpoint:** `max-width: 767px` only — desktop is unchanged.

## Intent

Every phone screen in Das Operator should feel like the **AI Crawlers / das-dashboard** surface the owner preferred: warm apothecary paper, hard-stop tricolor ribbon, raised metric tiles. Do not invent a second mobile design language.

## Anatomy (global shell)

1. **Header** — `paper-raised`, no bottom border on mobile; brand mark + hamburger + clock.
2. **Tricolor ribbon** — 4px hard-stop gradient Schwarz → Rot → Gold under the header (`.dx-mobile-tricolor` in `MobileShell`).
3. **Main canvas** — `--paper-sunk` tray so cards read as raised tiles.
4. **Content frame** — 16px side padding; bottom padding clears bottom nav + ribbon (~84px).
5. **Cards / panels** — `main .bg-card` → `--paper-raised`, `--border-hairline`, `--radius-md`, `--shadow-card`.
6. **Metric grids** — `.dx-metrics-grid` tiles use 14px padding and the same raised chrome.
7. **List tables** — stacked cards (`main table:not(.dx-keep-table) tr`) use the same tile chrome.
8. **Bottom nav** — `--brand-schwarz` bar, active item `--brand-rot`, 4px tricolor strip on the top edge.
9. **Page ribbon** — `.dx-ribbon-rule` stays visible on mobile (same hard-stop bar).

## Eyebrows

| Context | Mobile behaviour |
|---|---|
| Section titles inside panels (`dx-eyebrow-rot` not followed by `h1`) | **Show** — das-dashboard pattern |
| Page-level eyebrow immediately above `<h1>` (Master Data / Inventory) | **Hide** — list-page density |
| `h1 + p` subtitle on list pages | **Hide** |

## Opt-outs

- **Emailer** (`.dxmail-page`) — full-bleed own chrome; main paper-sunk is disabled via `main:has(.dxmail-page)`.
- **Wide matrices** — keep `.dx-keep-table` + horizontal scroll; do not force card stack.
- **Login** — no shell (no ribbon / bottom nav).

## Implementation map

| Piece | File |
|---|---|
| Shell + tricolor + bottom nav structure | `web/components/layout/mobile-shell.tsx` |
| Mobile CSS layer (rules 0–38 + “MOBILE DAS-DASHBOARD DEFAULT SKIN”) | `web/app/globals.css` |
| Tokens / mail page frame | `web/styles/das-design-tokens.css` |
| App icon (PWA / home screen) | `web/public/brand/app-icon-*.png`, `web/app/icon.png`, `web/app/apple-icon.png` |
| Dashboard section pattern | `web/components/home/ai-crawlers.tsx`, `ai-visibility-overview.tsx` |

## Rules for future UI work

1. Prefer global CSS / shell changes over per-page mobile hacks.
2. Never hard-code colours — use tokens from `das-design-tokens.css` / `Design/colors_and_type.css`.
3. One dark hero tile per dashboard section only (see das-dashboard.md).
4. When adding a new phone surface, match paper + ribbon + raised cards first; only then add bespoke layout.
5. Mirror documentation here **and** in `das-architektura/Design/` so agents and humans share one SSOT.

## App icon

- **Mark:** three heritage waves (Schwarz / Rot / Gold) on `--brand-schwarz` square with top tricolor hairline.
- **No wordmark** on the home-screen glyph (too small).
- **Theme color:** `#282229` (matches `viewport.themeColor` + `manifest.webmanifest`).
- **Assets:**
  - Design master: `Design/assets/app-icon-1024.png` (full square), `app-icon-squircle-1024.png` (preview)
  - Runtime: `web/public/brand/app-icon-{180,192,512,1024}.png`, `favicon-32.png`
  - Next metadata: `web/app/icon.png`, `web/app/apple-icon.png`
  - PWA: `web/public/manifest.webmanifest`
