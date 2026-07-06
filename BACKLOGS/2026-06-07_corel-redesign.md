# Corel Redesign — CorelDRAW Packaging Localization System

**Session date:** 2026-06-07
**Owner:** Aram (process architect) · executor: Claude
**One-line:** Build a system that freezes the packaging DESIGN and changes ONLY text per country, generating approval previews where nothing differs from the master except text — starting from existing CorelDRAW (.cdr) masters.

---

## 1. Goal (as set)

> «Система, по которой дизайн упаковки заморожен, а меняются только тексты/значения под разные страны; тестовые макеты со 100% точностью соответствуют дизайн-проекту. Сначала понять — реализуемо ли это с файлами CorelDRAW.»

Clarified during session → target output = **превью для согласования** (approval previews), NOT a print-ready file straight to the printer.

---

## 2. Feasibility verdict (delivered)

**Реализуемо — да, как система ТЕСТОВЫХ превью.** Geometry/positions/dieline freeze 100%. Color (CMYK/spot) and variable text length do NOT give 1:1 in a preview branch — that's format physics, not tooling.

Three hard facts about `.cdr`:
- Proprietary closed binary; no official spec. Third-party readers (libcdr in Inkscape/LibreOffice, UniConvertor) reliably handle only ≤ X4. Newer = lossy.
- CorelDRAW has **no headless mode**; automatable only via Windows macros (VBA/VSTA) with the app running.
- Cloudflare Workers cannot open `.cdr`. → `.cdr` stays the print master; the system works on a **derived SVG** (Corel export "As text" + embed fonts).

**Recommended architecture (hybrid, SVG core):**
- Corel = entry point (master .cdr → SVG-as-text, embedded fonts) + exit point (final PDF/X with CMYK).
- Cloudflare = middle: R2 (frozen SVG templates) + D1 (per-country strings, single source of truth) + Worker (render previews) + Pages (web editor where translators touch ONLY values, never geometry).
- This mirrors industry (Esko Dynamic Content + WebCenter, CHILI GraFx Smart Templates).

**100% accuracy checklist:** embed/installed fonts for ALL scripts; Corel export preset = Text "As text" + Embed fonts (used) + Rasterize OFF; color = RGB approximation only (print color only from Corel PDF/X + ICC); fit-to-box for overflow (shrink font, never widen tracking ≤1.0×); single fixed renderer (resvg); dieline as separate layer; placeholder keys versioned once (re-export = controlled re-map, not blind replace).

---

## 3. Pilot built — `~/packaging-localizer/` (PROVEN)

> Note: `/Users/dasexperten/CoWork/PROJECTS` is READ-ONLY (synced mirror), so the pilot lives at `/Users/dasexperten/packaging-localizer/`. Move into the repo when ready.

```
template/SYMBIOS.svg        frozen template, 12 data-field markers
strings.json                6 locales × 12 fields (RU, DE, AR, HY, KA, VI) — single source of truth
worker/src/substitute.js    CORE engine: token swap + fit-to-box + word-wrap + RTL + per-script font select (engine-agnostic)
worker/src/index.js         Cloudflare Worker: /render + API + web editor (scaffold)
worker/wrangler.toml        D1/R2/KV bindings scaffold
render.mjs                  local pilot renderer (shares substitute.js with the Worker) — uses @resvg/resvg-js
freeze_check.mjs            v1 freeze gate (regex strip) — SUPERSEDED, has false-frozen holes
freeze_check_v2.mjs         v2 freeze gate (structural parse+canonicalize) — USE THIS
seed/schema.sql + seed/seed_SYMBIOS.sql   D1 schema + 72 seed rows
out/                        rendered SYMBIOS_*.png + .svg for all 6 locales
detox_cdr/                  unzipped DETOX .cdr contents + artifacts (see §6)
```

Deps: `@resvg/resvg-js`, `opentype.js`. Fonts pulled from macOS system dirs (Arial, SF Arabic, Geeza Pro, etc.).

### Proven results
- **6 locales on ONE frozen template**, 5 writing systems: Latin, Cyrillic, Arabic (RTL), Armenian, Georgian + Vietnamese diacritics. Geometry pixel-identical, only text differs.
- Mechanisms demonstrated live on real renders:
  1. Text-only substitution by `data-field`.
  2. fit-to-box (DE headline shrank 30→20px; KA shrank 30→26 & 24→23).
  3. Multiline word-wrap (KA warning wrapped to 2 lines).
  4. Per-script font auto-selection (Arabic/Armenian/Georgian).
  5. RTL + Latin islands (Arabic brand/codes stay LTR).
  6. Missing data shows as visible `{{token}}` (safety, not silent drop) — caught a real missing `back.importer` for HY/KA/VI.

### Freeze guarantee (the "checking")
- **v1** (`freeze_check.mjs`): strips `<text>…</text>`, compares the rest. PASSED all 5 locales. BUT adversarial review found false-frozen holes.
- **v2** (`freeze_check_v2.mjs`): structural parse + canonicalize (sort attrs, decode entities, normalize numbers; whitelist only renderer-mutated text attrs: font-family/font-size/direction/text-anchor/x/data-x2; treat tspan as layout; non-field `<text>` payload = design). VERIFIED: passes all 5 SYMBIOS locales AND catches planted design drift (changed green-bar `fill` #2e9e5b→#ff0 → flagged with line+node). **This is the true "only text changed" gate. Use v2.**

---

## 4. The real DETOX file — investigation

File: `/Users/dasexperten/Downloads/25.0 DETOX box 70ml Q.cdr` (12.1 MB, CorelDRAW 2021, ZIP container).

Unzipped to `~/packaging-localizer/detox_cdr/`. Key findings:
- It's a toothpaste carton **dieline** (burgundy, das experten logo, "detox", cinnamon+clove, RU+EN text, 21 placed icon images, barcode).
- Vector is in proprietary `content/data/page1.dat` (12 MB) + `Bitmaps.dat` (714 MB uncompressed raster). **No PDF/SVG/EPS inside.**
- `META-INF/textinfo.xml`: everything on **ONE layer "Слой 1"** — design + images + text NOT separated by layer. 21 placed images enumerated (CINNAMON.png, CLOVE.png, GMP2.jpg, ce-mark.png, dasexperten_qr.png, cert icons, знак ЕАС, знак утилизации, ukrsert1.png, etc.).
- Embedded preview only 256×181 — too small as master.

---

## 5. The two walls (both proven empirically)

1. **`.cdr` is closed binary.** No tool on this Mac converts it faithfully — searched deep: no LibreOffice/libcdr, no Inkscape, no ImageMagick, no uniconvertor; npm/pip have no reliable X7+ reader. Corel's own SVG filter (`iesvg.dylib`) is a plugin, not a standalone CLI.
2. **CorelDRAW Mac cannot be automated.** No AppleScript dictionary (no `.sdef`, `NSAppleScriptEnabled` unset), no CLI, no headless. GUI automation via System Events is blocked: **`osascript is not allowed assistive access (-1728)`** = macOS Accessibility/TCC permission not granted to the controlling process (and TCC.db is SIP-protected, can't grant programmatically). The user also reports Mac Corel runs buggy.

---

## 6. BREAKTHROUGH: automatic .cdr → image via QuickLook

**`CorelDRAW.CDRQuicklook.qlgenerator`** is installed and registered for `.cdr`. It renders the file to a raster **fully automatically — no GUI, no Corel launch, no Accessibility:**

```
qlmanage -t -s 1800 -o <outdir> "<file.cdr>"   # max ~1800px; 2048+ fails; -p preview crashes
```

Produced `detox_cdr/ql_best_1800.png` (1800px) — the real DETOX design extracted programmatically.

**Limit (honest):** it's a **flat raster with text baked in.** Cannot hide the text layer, cannot give editable `<text>`/vector with coordinates. So it is a faithful **design reference**, but it does NOT by itself enable "swap only text" (which needs the vector/text structure → only Corel's SVG export provides that).

---

## 7. PC path (ready to fire)

CorelDRAW on **Windows** is genuinely scriptable (VBA). Prepared:
- `detox_cdr/ExportDETOXtoSVG.bas` — Windows VBA macro: export active doc → SVG with text-as-text + embed-fonts(used) + no-raster. (API honesty: SVG options aren't typed VBA props — macro shows the dialog once, Corel remembers; filter resolved by extension to avoid enum guess. Verified against Corel SDK: Document.ExportEx → ExportFilter.ShowDialog/.Finish.)
- Manual fallback (no macro): File → Export → SVG, tick **As text** + **Embed fonts → Fonts used** + **Bitmaps → Embedded**.
- Verify: open .svg in Notepad, search `<text` → present = editable.

Mac/PC bridge: same LAN (Mac 192.168.10.192). No confirmed OneDrive/synced bridge folder; CoWork is local & mostly read-only. Proven transfer channel = `~/Downloads` (where the .cdr arrived). A Downloads watcher was set up to auto-detect the exported SVG.

---

## 8. DETOX field plan (ready, drops into proven renderer)

Saved: `detox_cdr/DETOX_field_plan.json`. Keys reuse the proven SYMBIOS convention → zero renderer changes.

- **FRONT:** front.h1 / front.h2 / front.claim (editable, wrap, maxlines=2) ; front.sku_name, front.brand_logo, front.volume (volume label editable).
- **BACK:** back.inci_label (editable label) + back.inci (frozen body); usage/warning/storage/manufacturer/trademark/batch/expiry/barcode = frozen-legal.
- **LEFT side:** importer_label (editable) + importer (frozen, per-market row selection).
- **RIGHT side:** tagline (editable) + cert_icon_labels (frozen).
- **TOP/BOTTOM flaps:** sku_name/volume, batch/expiry (overprint).
- **Frozen blocks (verbatim, via legalizer/product-skill):** INCI, importer list (8 markets ME/RU/UA/KG/PL/RO/GE/AM from SECRETS/legal-entities.md + distributors.md), manufacturer (SECRETS/manufacturers.md), warnings/storage/usage, trademark IR 1550919, batch/expiry format, EAN-13 barcode, 21 placed cert/icon images (never `data-field`).
- DETOX known copy: h1="Зубная паста с эфирными маслами корицы и гвоздики." h2="Обеспечивает комплексный уход за зубами и деснами. Успокаивает десны и укрепляет их." claim(italic)="Масло гвоздики давно известно своими спазмолитическим и лечебными свойствами."

---

## 9. Workflows run this session

1. **coreldraw-template-feasibility** (6 agents) → feasibility verdict + architecture + accuracy requirements.
2. **extend-demo-locales** (6 agents) → HY/KA/VI translations, script-verified.
3. **detox-pipeline-process-and-check** (5 agents) → Corel export automation (Mac script verdict = "broken"), DETOX field plan, adversarial freeze-guarantee review (drove v1→v2).

Scripts saved under the session's `workflows/scripts/`.

---

## 10. OPEN — next steps / decision pending

**Blocking decision for Aram (he will direct):**
- **(A) Editable text-swap (the real goal)** → needs ONE Corel SVG export from the PC (3 clicks or the .bas macro) → drop `DETOX_master.svg` in `~/Downloads`. Then automatic here: mark `<text>` nodes with field-plan keys → render per locale → `freeze_check_v2` proves only text changed.
- **(B) Design-as-reference only** → already have `ql_best_1800.png` automatically; can build a preview concept on it (raster background; text overlay would be approximate, not 1:1).

**Backlog items when SVG arrives:**
- [ ] Apply `data-field` keys + `data-wrap`/`data-maxlines` to real DETOX `<text>` nodes (once).
- [ ] Add "DETOX" block to `strings.json` (per-locale).
- [ ] Render DETOX previews, run `freeze_check_v2`.
- [ ] Decide on the re-export key re-mapping discipline (operational risk #1 for longevity).
- [ ] Deploy Worker to Cloudflare (D1/R2/KV) for live preview URL + web editor.
- [ ] Optional hardening: hash each placed bitmap, assert constant hash-set across locales.
- [ ] Color: define ICC pass so RGB preview doesn't mislead vs print; final CMYK PDF/X stays in Corel.

---

## 11. Key paths (resumability)

- Pilot: `/Users/dasexperten/packaging-localizer/`
- Engine: `worker/src/substitute.js` · Gate: `freeze_check_v2.mjs` · Renderer: `render.mjs`
- DETOX: `/Users/dasexperten/Downloads/25.0 DETOX box 70ml Q.cdr` ; unzipped + artifacts in `packaging-localizer/detox_cdr/`
- Auto raster: `detox_cdr/ql_best_1800.png` (via `qlmanage -t -s 1800`)
- PC macro: `detox_cdr/ExportDETOXtoSVG.bas` · Field plan: `detox_cdr/DETOX_field_plan.json`
- Existing system skill that this extends: `SKILLS/designer/` (MODE B = svg_editor.md, manual text audit; this session systematizes it).

**Bottom line:** engine + checking + field plan are done and proven. Last wall = getting the vector/text out of `.cdr`, which on this setup requires one Corel SVG export on the PC. Everything downstream is automatic.
