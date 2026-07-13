# das-dashboard — Command-Center Dashboard Pattern

**Status:** Canonical design pattern · approved by owner 2026-07-10  
**Mobile default:** This pattern is the **global mobile UI language** for Das Operator (all pages &lt;768px). See [mobile-ui.md](./mobile-ui.md).  
**Reference implementation:** `web/components/home/ai-visibility-overview.tsx`, `web/components/home/ai-crawlers.tsx`  
**Tokens source:** `web/styles/das-design-tokens.css` (never hard-code values)

## Anatomy

1. **Container** — `--paper` canvas, `1px --border-subtle`, `--radius-lg`, overflow hidden.
2. **Tricolor ribbon rule** — 4px top bar, hard-stop gradient Schwarz → Rot → Gold (33.33% each). Marks every das-dashboard instance.
3. **Header row** — `dx-eyebrow-rot` section title + 12px `--fg-3` subtitle; right side: updated-at meta + `Full report ↗` link in `--brand-rot`.
4. **Hero tile (dark)** — exactly ONE `--brand-schwarz` tile per dashboard, the single dark element on the page = the eye-catcher. Big number in a gold (`--brand-gold`) SVG arc gauge, pill badge `rgba(254,240,4,.16)` bg. Never use two dark tiles.
5. **Metric tiles** — `--paper-raised`, `--border-hairline`, `--radius-md`, `--shadow-card`, 14px padding. Structure: label + health dot (`--status-success`/`--status-warning`) → 26px/900 number (`dx-mono`, tabular) → 11px trend line (↑ `--status-success` / ↓ `--brand-rot`) → hairline-separated 10px footer meta.
6. **Panel cards** — `--paper-raised` cards with `dx-eyebrow` 11px header + source tag right; sparklines stroke `--brand-rot` with `rgba(229,32,44,.07)` fill; horizontal bars on `--paper-sunk` track, `--radius-pill`.
7. **Bottom strip** — `--paper-sunk` tray with pill chips (`--paper-raised`, `--border-subtle`, `--radius-pill`), inline verdict in ✓/✗ status colors.

## Rules

- Grid rhythm: 14px gaps, section margin-bottom 14–16px.
- One dark hero per dashboard. Gold only inside the dark hero.
- Trends: arrows + percent, color = direction, never text like "up/down".
- Fonts: Archivo only; numerals `dx-mono` (tnum). No new fonts, no gradients besides the ribbon rule.
- Demo/stub data must render a `· demo data` marker in `--status-warning` next to updated-at.

## Data contract (ai-visibility instance)

| Block | Source | Status 2026-07-10 |
|---|---|---|
| Google Search panel | GSC API | pending site verification |
| Citations, share of authority, grounding queries | Clarity AI Visibility | live in Clarity, export [TO CONFIRM] |
| Traffic from AI | GA4 Data API (property 511756146) | ready |
| Crawled-by tiles | CF AI Crawl Control | blocked until NS-flip |
