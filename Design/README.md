# Das Experten — Design System

> **"Innovativ und praktisch."**
> German-engineered oral care. Microbiome-friendly. Fluoride-free. Unafraid.

This folder is the source of truth for anyone designing for the **Das Experten** brand — a German oral care company producing fluoride-free, microbiome-friendly toothpaste, brushes, and floss, positioned as a science-forward challenger in the category.

---

## The brand at a glance

- **Company:** Das Experten GmbH (Germany)
- **Category:** Oral care — toothpaste, toothbrushes, dental floss, interdentals, mouthwash
- **Positioning:** Organic, microbiome-friendly, SLS-free, paraben-free, fluoride-free
- **Heritage cue:** Three waves in the German flag palette (Schwarz–Rot–Gold) — the logomark reads as cleansing motion + German engineering provenance
- **Voice:** Challenger DTC — punchy, provocative, science-backed. *"Your toothpaste is failing you. We fixed it."*
- **Product lines observed:** innoWeiss (enzyme whitening, electric-blue accent), Detox (charcoal, black accent), plus Fresh / Sensitive / Kids product tiers inferred from category conventions

### Sources used to build this system

Provided by the user:

| Source | Path in project |
| --- | --- |
| Full logo (PNG, 1764×306) | `assets/logo-full.png` |
| Packaging: innoWeiss 70ml carton dieline | `assets/packaging-innoweiss-70ml.jpg` |

Public references consulted:

- `https://www.dasexperten.com/` and `/about-us`, `/worldwide`
- `https://www.dasexperten.com/` (official store)
- `https://dasexperten.biz/` (distributor copy, tone samples)
- `https://www.instagram.com/dasexperten/`

> ⚠️ **No codebase or Figma was provided.** UI kits in `ui_kits/` are an **elevated reinterpretation** of the brand DNA (logo + packaging + public copy) pushed toward a premium / clinical / modern direction per the user's brief — they are not pixel-faithful recreations of the live site. See *Caveats* at the bottom of this document.

---

## Content fundamentals

### Voice

Das Experten's copy is a **two-register challenger voice** with a distinctive cadence. The design system leans into the bolder register.

1. **Provocation →** Short, declarative. Often a rhetorical question or accusation.
2. **Evidence →** Specific science, ingredient names, mechanism. The clinical register.
3. **Resolution →** A branded alternative framed as inevitable.

**Example (lifted from their own site, slightly paraphrased):**

> "You brush your teeth every day, thinking you're protecting them. But what if your toothpaste is doing more harm than good? Abrasives scrape away enamel. Harsh antiseptics kill the good bacteria your gums need. At Das Experten, we use cutting-edge science and nature's most powerful ingredients to revolutionize oral care."

### Casing & punctuation rules

- **Product names** are always set in the brand lockup: lowercase `das experten`, with `innoWeiss`, `Detox`, etc. as their own marks. The ® is present on primary placements.
- **Headlines** are generally sentence-case or title-case, never all-caps — echoing the lowercase wordmark.
- **ALL CAPS** is reserved for micro labels (eyebrows, badges, category tags). Track them wide (`letter-spacing: 0.18em`).
- **Em dashes** (—) are used liberally to set up the "old way vs. smart way" contrast.
- **Check-and-X** (✅ / ❌) lists are a signature on-site. In premium execution, replace the emoji with custom glyphs (see *Iconography*).
- **German tagline** *"innovativ und praktisch"* appears below the wordmark in **sentence-case, not title-case**.

### Pronouns & point-of-view

- Address the reader as **"you"** — direct, confrontational.
- Das Experten speaks as **"we"** — collective, authoritative, a little conspiratorial ("we don't believe in surface-level illusions").
- The competition is **"they / most toothpastes / the old way"** — never named.

### Do / Don't

| ✅ Do | ❌ Don't |
| --- | --- |
| "Your toothpaste is failing you." | "Das Experten is a leading oral care brand." |
| "Enzymes dissolve stains. No grinding. No damage." | "Our advanced formula gently cleans your teeth." |
| "Fluoride-free. Microbiome-friendly. Clinically proven." | "Discover our full range of premium oral care." |
| Set up a villain (abrasives, antiseptics, fake whitening). | Speak in vague benefit claims. |
| Use German on product marks and seals. | Over-translate — keep some German. It's the point. |

### Emoji

- **Allowed in social / store listings** (🦷 🦠 ✨ 🚀 ✅) — present on the public site.
- **Not used in the elevated design system.** We replace emoji with icon-font glyphs for print, packaging, and premium web surfaces. Social posts may still use them.

---

## Visual foundations

### Colors

The palette is built on three rings:

1. **Heritage (flag palette)** — used as **accents**, never as large fills. Sampled directly from `logo-full.png`.
   - **Schwarz** `#282229` — warm off-black, primary ink
   - **Rot** `#E5202C` — CTAs, the signature underline, challenger emphasis
   - **Gold** `#FEF004` — highlight, a dab of optimism, warning

2. **Apothecary neutrals** — the canvas. Warm off-whites and stones that feel like a pharmacy ledger, not a tech SaaS.
   - `--paper` `#FBFAF6` (base), `--paper-sunk` `#F3F0E8`, stones from `100` → `700`.

3. **Product-line accents** — one per SKU family, used on badges, stripes, and packaging header bars.
   - innoWeiss → `#0D199E` (sampled from the packaging)
   - Detox → charcoal `#1A1519`
   - Fresh / Sensitive / Kids → inferred apothecary green / violet / orange

See `colors_and_type.css` for the full variable list.

### Typography

Two-font system, plus a serif for accent numerals and a mono for clinical data.

| Role | Family | Notes |
| --- | --- | --- |
| Display & headlines | **Eras Bold ITC** | The actual brand wordmark face — uploaded as `fonts/Eras-Bold_Regular.ttf`. Used for product names (innoWeiss, Detox, etc.) and large display type. |
| Body & UI | **Archivo** (400–700) | Geometric sans for body and interface text, range of weights. |
| Meta & eyebrows | **Archivo Narrow** | Condensed for tags, captions, German tagline. |
| Accent / numerals | **Fraunces** (italic 500, bold 700) | Apothecary stat numerals, pull quotes. |
| Clinical / ingredients | **Manrope** (500) | Lab readouts, ingredient lists, lot numbers, order refs. Replaces JetBrains Mono — proportional sans, normal tracking. |

> Eras Bold ITC is the real brand display typeface (extracted from the wordmark). The `.dx-product-name` class applies it across product cards, packaging, PDPs, and slides — sentence-case, no tracking, no uppercase.hivo 900. **If you have the original brand typeface files, please drop them into `fonts/` and update `colors_and_type.css`.** All substitutions are free and loaded from Google Fonts — no local `.ttf` files ship with this system.

Scale: decisive modernist. Display sizes are heavy and tight (`letter-spacing: -0.03em`). Body stays at `16px` with `1.55` line-height. Eyebrows and micro labels go ALL CAPS at `11px` with wide tracking.

### Spacing & layout

- **8pt base grid**; tokens `--space-1` through `--space-10`.
- **12-col web grid**, 1200px max, 72px outer gutters on desktop.
- **Apothecary label layout:** information-dense, multi-column, **hairline rules** (1px, `rgba(26,21,25,.08)`) between blocks. Lots of whitespace around cluster boundaries.
- **Fixed elements:** a slim **top ribbon** (44px) displays the German tagline and store locator. Primary nav is 72px, sticky with a hairline bottom border.

### Backgrounds & imagery

- **Primary surface** is the warm paper (`--paper` `#FBFAF6`). Not pure white — pure white reads sterile, and we want *apothecary*.
- **No ambient gradients** in UI chrome. Gradients are used *only* on product-line panels as a soft vertical tint in that line's accent color.
- **Photography direction:** studio stills on stone/ceramic props, warm natural light, restrained color (cream, beige, brass). Avoid glossy beauty lighting. Think *pharmacy shelf, not Instagram.*
- **No hand-drawn illustrations.** If editorial illustration is ever needed, use a high-contrast woodcut / engraving style (a nod to German pharmacopoeia).
- **The three ribbons** from the logomark are the single repeating graphic motif — used as section separators, underline accents, and end-of-article marks. Never stretched, never recolored.

### Motion & interaction

- **Easing defaults** are custom: `--ease-standard` = `cubic-bezier(.2,.7,.2,1)` (gentle lead-in, firm settle). `--ease-emphasis` adds a small overshoot for CTA hovers.
- **Durations:** 120ms (fast / hover), 200ms (base / state change), 360ms (slow / modal / reveal).
- **Hover states:** we *darken* CTAs (rot → deeper rot), we don't lighten. Neutral buttons shift background to `--bone`. Links pick up a 2px red underline from below, not change color.
- **Press states:** `scale(.98)` + lose shadow. 80ms, `--ease-exit`.
- **No bounces, no springy modals.** This is pharmacy, not playful DTC. The one exception: `--ease-emphasis` for primary CTA on hover.
- **Fades** (opacity 0→1, 200ms) for content reveal. **No slide-ins** for UI (slides are OK for carousels).

### Borders, shadows, elevation

- **Hairlines everywhere.** 1px at `rgba(26,21,25,.08)` is the workhorse. Buttons, cards, inputs, dividers.
- **Shadows are low and printed**, not glassy:
  - `--shadow-card`: tiny 1px lift + hairline ring
  - `--shadow-raised`: subtle 16px blur, still warm (no blue tint — shadow RGB is the brand schwarz at low alpha)
  - `--shadow-float`: reserved for dropdowns / modals
- **Inner shadows** (`--shadow-inset`) on input fields only.
- **No colored shadows.** No "brand glow" CTAs.

### Transparency & blur

- **Blur is used once:** on the sticky nav, a 12px backdrop-filter blur over a 92% paper tint. That's it.
- **Transparency** is used for hairlines and for hover overlays over product imagery (10% brand schwarz).

### Corner radii

Restrained. The brand's visual weight is in the type and ribbons, not rounded corners.

- `--radius-xs` 2px — inputs, small tags
- `--radius-sm` 4px — buttons, badges
- `--radius-md` 6px — cards, modal sheets
- `--radius-lg` 10px — hero panels, product imagery frames
- `--radius-pill` — **only** on category chips / tag pills

### Cards

Two card archetypes:

1. **Apothecary card** — warm paper fill, hairline border, subtle shadow, 6px radius. Tight internal padding. Title in Archivo 800, body in Archivo 400.
2. **Product card** — white fill, no shadow, hairline border, 10px radius. Product shot on paper-sunk ground (`--paper-sunk`). Product-line accent strip (4px) pinned to the top edge.

### Layout rules (fixed elements)

- **Top ribbon** (44px, inverse / schwarz) — tagline + language toggle + store locator
- **Primary nav** (72px, paper + backdrop blur) — wordmark left, 5 nav items, cart + account right. Red underline slides under the active item.
- **Footer** (paper-sunk) — 4 columns, always the three ribbons as the top divider.
- **Product grid:** always 4 up on desktop, 2 up on tablet, 1 up on mobile. 24px gutter.

---

## Iconography

Das Experten's public materials are **not consistent** about iconography. They use emoji (🦷 🦠 ✅ ❌) inline with body copy, and generic category icons on the store. For the elevated system we commit to a single icon set.

- **Primary icon system:** **Lucide** (`https://lucide.dev`), loaded from CDN. Rationale: 1.5px stroke, rounded line caps, open-source, has the clinical/lab flavor without being overly whimsical. Matches the thin-hairline rule of the system.
- **CDN:** `https://unpkg.com/lucide@latest/dist/umd/lucide.js`
- **Flag / heritage mark:** the three ribbons are **not** an icon — they're a brand asset. Use `assets/logo-mark.png` (or a future `.svg` version) verbatim, never redrawn in a stroked-icon style.
- **Product-line icons:** none currently; each line is identified by its accent color + wordmark (innoWeiss, Detox, etc.), not by a pictogram.
- **Emoji:** allowed only on social and in raw store listings. **Not allowed** in product UI, packaging, decks, email templates.
- **Unicode as icons:** the wordmark's *piped* tagline end-mark (a thin vertical rule after "praktisch") is the one Unicode-ish device used — we reproduce it as the `.dx-pipe` CSS utility rather than a `|` character.
- **Custom glyphs we ship:** `check-cross` (our own ✅/❌ replacement, using schwarz tick and rot ex), and the `ribbon-rule` divider (`.dx-ribbon-rule`).

> ⚠️ **Substitution flagged.** Lucide is a reasonable, brand-neutral match but not an asset the brand owns. If Das Experten has a brand-specific icon set (or uses another system internally), replace `assets/icons/` with those files and update this section.

---

## Index — what lives where

```
/
├─ README.md                      ← you are here
├─ SKILL.md                       ← agent skill manifest (Claude Code compatible)
├─ colors_and_type.css            ← ALL design tokens; import first in any page
├─ assets/
│   ├─ logo-full.png              ← full horizontal lockup
│   ├─ logo-mark.png              ← 3 ribbons only
│   ├─ logo-wordmark.png          ← type only
│   └─ packaging-innoweiss-70ml.jpg
├─ preview/                       ← Design System tab cards
│   ├─ type-*.html
│   ├─ colors-*.html
│   ├─ spacing-*.html
│   ├─ components-*.html
│   └─ brand-*.html
├─ ui_kits/
│   ├─ marketing/                 ← dasexperten.com homepage + PLP
│   ├─ ecommerce/                 ← PDP + cart + checkout
│   ├─ distributor/               ← B2B portal (login, catalog, order)
│   └─ packaging/                 ← carton templates & label system
└─ slides/                        ← distributor pitch deck template
```

All HTML files import `colors_and_type.css` with a relative path. Assets are referenced relatively.

---

## Caveats & open questions

1. **No codebase, no Figma.** The UI kits are an informed reinterpretation, not a 1:1 recreation. If a real codebase or Figma exists, attach it and I'll rebuild to match.
2. **Brand typeface partially uploaded.** The client uploaded `fonts/Eras-Bold_Regular.ttf` (the wordmark face), but the file is **corrupted** — browsers reject it with "Invalid font data in ArrayBuffer". The CSS keeps `Eras Bold ITC` as the first family in the display stack so a working re-upload activates instantly; until then, display falls back to **Archivo Black**, the closest free analogue. `fonts/megafonts_inc.ttf` loads fine but isn't wired in yet — let me know where you want to use it.
3. **Only one packaging SKU was provided** (innoWeiss 70ml). Other product lines (Detox, Fresh, Sensitive, Kids) and their accent colors are **inferred** — treat them as starting points, not canonical.
4. **Iconography.** Lucide is a placeholder-quality default. If the brand has a proper icon set, swap it in.
5. **No photography was provided**, so product cards use CSS placeholders. Shoot on stone/ceramic props with warm natural light per the *Visual foundations → Backgrounds & imagery* spec.
6. **Tone chosen: challenger DTC.** Per the intake, the design leans into the provocative register. If the brand wants to dial toward the clinical/science voice for certain surfaces (e.g. dentist-facing distributor portal), pass that note and I'll soften accordingly.
