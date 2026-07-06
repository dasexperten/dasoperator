---
name: das-experten-design
description: Use this skill to generate well-branded interfaces and assets for Das Experten (German premium oral-care brand), either for production or throwaway prototypes/mocks/etc. Contains essential design guidelines, colors, type, fonts, assets, and UI kit components for prototyping.
user-invocable: true
---

Read the README.md file within this skill, and explore the other available files.

If creating visual artifacts (slides, mocks, throwaway prototypes, etc), copy assets out and create static HTML files for the user to view. If working on production code, you can copy assets and read the rules here to become an expert in designing with this brand.

If the user invokes this skill without any other guidance, ask them what they want to build or design, ask some questions, and act as an expert designer who outputs HTML artifacts *or* production code, depending on the need.

## Quick orientation

- `README.md` — brand story, tone, visual foundations, iconography, index.
- `colors_and_type.css` — CSS variables (colors, type, spacing, shadows, radii). Import this first.
- `fonts/` — Eras Bold ITC (uploaded TTF is corrupted; falls back to Archivo Black). Manrope, Archivo, Archivo Narrow, Fraunces loaded via Google Fonts.
- `assets/` — logos, packaging renders, product photography.
- `ui_kits/marketing/` — homepage hero, nav, product grid, footer.
- `ui_kits/ecommerce/` — product detail page + cart drawer.
- `ui_kits/distributor/` — B2B partner portal dashboard.
- `ui_kits/packaging/` — carton chassis, anatomy, claim strips, seals.
- `slides/` — distributor pitch deck (deck-stage based, 1920×1080).
- `preview/` — design-system preview cards.

## Core visual DNA

- **Colors:** Schwarz `#1A1519` (ink) · Rot `#E5202C` (accent) · Gold `#FEF004` (highlight) · Paper `#F6F3EE`. Five product-line accents (innoWeiss blue, Detox schwarz, Fresh green, Sensitive purple, Kids orange).
- **Type:** Eras Bold ITC display (the brand wordmark face), Archivo body, Archivo Narrow for UPPERCASE eyebrows, Manrope for clinical / ingredient / order-ref readouts (no expanded tracking). numerals / codes / SKUs.
- **Layout:** Confident, editorial. Large display type. Rot accent bars and numbered systems. Schwarz for "villain" framing, rot for headline moments, paper for everyday.
- **Tone:** Challenger-brand clarity. German directness. "Innovativ und praktisch." Uses "you" in English, "Sie" in German. No exclamation marks. No emoji.

## Don'ts

- No bluish-purple gradients. No emoji cards. No rounded-corner + left-border-accent cliché.
- Don't invent new packaging lines — the five exist (innoWeiss, Detox, Fresh, Sensitive, Kids).
- Don't use fluoride imagery — the brand is fluoride-free.
- Don't soften the voice. It's confident, slightly confrontational toward the old category.

## Interaction principles — MANDATORY (Aram directive 2026-07-02)

Every interface built with this system implements these tiers. Source of truth: `_tools/design-principles.md` in the CoWork root; rules embedded here so the bundle is self-contained.

**Universal (every viewport):** low cognitive load (one decision per view where flow allows); discoverable (no function hidden solely behind hover, gesture, or shortcut); distraction-free (no animation that is not user feedback, zero decorative elements, one accent color per screen — Rot); space-efficient (no element without information; secondary metadata behind disclosure). Never write "intuitive"/"user-friendly" in specs — they are outcomes, not instructions.

**Desktop (≥768px / mouse):** visible hover state on every interactive element (use `--dx-hover-*` tokens); keyboard shortcuts for high-frequency actions, documented in-UI; right-click context menus on data objects with a visible button path to the same actions; visible focus ring (`--dx-focus-ring`) + logical tab order, no focus traps; resizable multi-pane layouts with persisted sizes.

**Mobile (<768px / touch):** apply `_tools/mobile-friendly.md` completely — 44×44px tap targets, primary actions in bottom 60%, gestures with button fallbacks, glanceable key metric. Never port hover, right-click, or dense multi-column tables to mobile.

Responsive work = universal + desktop tier at desktop breakpoints + mobile tier at mobile breakpoints, same codebase.
