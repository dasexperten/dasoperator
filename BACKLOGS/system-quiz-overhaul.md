# System Quiz Overhaul — dasexperten.de `/system`: full build + 3-round redesign to mechanism-AIDA
<sub>Session date: 2026-06-06</sub>

**Project:** `PROJECTS/dasexperten-de-website/` → Cloudflare Pages `dasexperten-de`
**Live:** https://dasexperten.de · `/system` `/de/system` `/ru/system` `/vn/system` (EN/DE/RU/VN)
**Deploy:** `npx wrangler@latest pages deploy ./public --project-name=dasexperten-de --branch=main --commit-dirty=true`
- Auth: **CF Cloud Master** token (the Cloudflare DEFAULT token — NOT Full Infra; Full Infra lacks the Pages scope → auth error 10000). Read it from `SECRETS/cloudflare.md` into `CLOUDFLARE_API_TOKEN` at runtime; never inline it in a shell command (leaks to transcript). Account `081ddb85cb399ad62a70210328d744fc`. Helper pattern used: a throwaway `_deploy.js` that regex-extracts the token from `cloudflare.md` → env → `spawnSync(wrangler)`.
- Local preview during the session: tiny static server `_devserver.js` (Cloudflare-Pages-style clean URLs) on `http://localhost:5599`, launched via `.claude/launch.json` (dev-only, not deployed). Python absent on this machine; used Node.

---

## TL;DR — what this session did

The `/system` quiz ("Build your oral-care system") existed as a basic 4-question paste+brush matcher. Over this session it was **rebuilt and then redesigned three times** in response to Aram's feedback, ending as a **7-question, mechanism-led, AIDA-structured quiz** validated through marketing gates and a Monte-Carlo result-distribution check, live in 4 languages.

Arc:
1. **Engine rebuild** — ported the rich microbiomefriendly.me/quiz mechanics onto the Das Experten "build a system" concept (real live-map, cart-integrated result).
2. **Copy parity** — brought EN/DE/VN up to RU's richness (reveal+fact), fixed a RU reveal/label misalignment bug.
3. **Round 1 (shorten + red):** questions made short with red-highlighted hook words.
4. **Round 2 (click-to-advance):** removed the redundant Next button; clicking an answer advances; Back kept; clinical clue carries to the top of the next step.
5. **Round 3 (mechanism redesign):** scrapped "look in the sink" primitivism. New 7-question quiz built on the site's own logic ("Choose your MECHANISM — not a flavour"), AIDA arc, intrigue-first opener, results balanced ~25% per mechanism pillar and biased to real top sellers.

---

## FINAL STATE (live & verified)

### Files & cache versions (all 4 system pages)
- `public/system.js?v=16` — quiz engine (shared, language-agnostic)
- `public/styles.css?v=18` — quiz styles (+ `.qhl` red highlight, `.sys-readmap` result map)
- `public/system-data.js?v=8` (EN) · `system-data-de.js?v=8` · `system-data-ru.js?v=8` · `system-data-vn.js?v=8`
- `public/assets/cart.js?v=9` — now exports `window.DXCart={add,open,has}` and is loaded on the `/system` pages
- `public/{,de/,ru/,vn/}system.html` — script refs bumped; hero/meta copy "Four → Seven honest questions"

### Engine (`system.js` v16) — features
- **Real live risk-map:** 4 fixed axes (Gums / Microbiome / Sensitivity / Stain), filled from REAL accumulated paste-weight scores, **normalized to the leading axis** (`axisPct = round(axisRawAt(i)/maxRaw*100)`). (Earlier `raw*16` saturated all axes to 100% once question count grew — fixed.)
- **Click-to-advance:** clicking an option selects + auto-advances after 260ms (`advancing` guard). No "Next" button. "Back" kept. Last question → result.
- **Clinical clue carries forward:** `revealHtml(step-1)` shows the previous answer's clue at the top of the next step; last clue shown on the result.
- **Safe red highlight:** `hl()` converts `[[word]]` → `<em class="qhl">word</em>` (escapes everything else first — XSS-safe). Applied to question, fact (qfact), and reveal.
- **Cart-integrated result:** matched paste added to the live Stripe cart in one tap when buyable; `BUYABLE = {DE201,DE202,DE205,DE206,DE210}`. Non-buyable paste → "See it in the shop" link. Brush always a recommendation (brushes are not in the Stripe checkout catalog). Final "your mouth, read back" axis map shown on result.
- Works for any question count (loops `Q.questions`; progress dots = question count).

### The 7 questions (EN master) — AIDA arc
1. **(Attention/intrigue, not-obviously-teeth)** "Your mouth holds more living bacteria than `[[Earth has people]]` — friend or foe?" · fact: a sterile mouth is `[[not]]` a healthy mouth; your microbiome is a defense system.
2. **(Interest/myth)** "That `[[bright smile]]` after brushing? It might just be `[[dehydration]]`."
3. "When your gums `[[bleed]]`, is it the brush — or a `[[warning]]`?" (was a "pink in the sink" line — **"sink" removed**, Aram hated it)
4. "Cold water, a spoonful of ice cream — does a `[[jolt]]` hit your teeth?"
5. "Coffee, wine, or a cigarette — is one `[[quietly staining]]` your teeth daily?"
6. "Brushing for kids, braces or a `[[pregnancy]]` — does your paste `[[fit a fragile mouth]]`?"
7. **(Action)** "Twice a day — is your paste still just `[[abrasives and fluoride]]`, or working for you?"

Each question: ≤15 words, ends as a question, 1–3 red hook words, mirrors a real consumer belief/fear; each of its 4 options carries `paste_weights`+`brush_weights`+a `reveal` (clinical clue where the product "arrives" as the reader's own conclusion, with real clinical numbers from product-skill: e.g. DETOX cytokines −87-98% / P.gingivalis −74% / mineral loss −65%; SYMBIOS B.coagulans 4·10¹⁰ CFU; INNOWEISS biofilm 52-69%, enamel ~8-11nm; SCHWARZ +6 SGU/4wk, RDA 79; GINGER saliva +26-40%, P.gingivalis 65-79%; THERMO 39° +40% @39°C; EVOLUTION CPP-ACP up to 90%).

### Brand logic the quiz now follows (studied from dasexperten.com)
- Central command of the site: **"Choose your MECHANISM — not a flavour."** Villain narrative: abrasives scrape enamel · harsh antiseptics kill good bacteria (sterile ≠ healthy; microbiome = defense) · "whitening" = dehydration · fluoride. Science = 5-enzyme cascade / live probiotics / 39°C termo-activation. Fluoride-FREE.
- → Quiz routes to **4 mechanism pillars**, each with a buyable top-seller hero:
  - **Enzyme** → INNOWEISS DE210 (sec. THERMO 39° DE209)
  - **Probiotic** → SYMBIOS DE206 (sec. EVOLUTION DE208, BUDDY DE207)
  - **Natural/botanical** → DETOX DE202 (sec. COCOCANNABIS DE205, GINGER FORCE DE203)
  - **Charcoal/other** → SCHWARZ DE201 (never call it "detox")

### Result distribution — tuned & validated (Monte-Carlo, 300k random answer paths on the live EN data)
- **enzyme 25.8% · probiotic 22.8% · natural 26.9% · charcoal 24.5%** (Aram asked ~25/25/25/25 with a natural emphasis — natural is the largest share).
- **Buyable result share 99.2%** (cart almost always works).
- Top winning pastes = the buyable bestsellers: **INNOWEISS 26% · DETOX 25% · SCHWARZ 24% · SYMBIOS 23%**; COCO/GINGER situational (~1%). This matches real WB top-sellers (review-count proxy: SCHWARZ 2388, DETOX 2307, SYMBIOS 1830, INNOWEISS 1077, GINGER 1033 — one hero per pillar). Ozon had no sales data in-repo (only slide images).
- Tuning method: architect agent designed weights → I Monte-Carlo'd → enzyme was over (32%)/natural under (19%) because INNOWEISS's stray secondary `DE210:1` weights in charcoal options pulled mixed paths to enzyme. Swapped those secondaries toward `DE202` (natural), restored 2 to keep enzyme ≈25%. Deterministic, re-validated.

### Marketing gates applied (skills, this session)
- **product-skill** + **technolog** — product/tech facts (canonical names, clinical numbers, THERMO/`Termo 39°` spelling — Aram confirmed "Termo 39°" is correct; result cards keep it; reveals normalized "THERMO 39"→"TERMO 39°").
- **marketolog** — Hero Intrigue Lock (every question a Knowledge-Gap/Uncomfortable-Truth hook), AIDA arc, force-decision, You-attitude, SCHWARZ-never-"detox", no competitor names.
- **benefit-gate** — consumer mind map + Mirror→Reveal-the-Gap→Let-the-Solution-Arrive (product arrives in the reveal as the reader's own conclusion).
- **conversion gate** (benefit-gate Mode B) — 5 checks per question (relevance / their-POV / one action / zero friction / skeptic leans in).
- **segment-check** — 8 fixed типажи, target ≥6/8 understand on first read (kept intrigue but plain framing).
- Run as multi-agent **Workflows**: architect → 3 gates in parallel → synthesis → translate (DE/RU/VN). 4 workflows total across the session.

---

## Files touched this session
- `public/system.js` — full engine rewrite (real map, click-advance, hl(), cart result, carry-forward clue). v12→v16.
- `public/styles.css` — `.qhl`, `.sys-readmap`/`.srm-row`, `.sys-foot-note`, reveal margin. v15→v18.
- `public/system-data.js` / `-de.js` / `-ru.js` / `-vn.js` — questions fully replaced (4→7), reveal/fact added, map_axes + new UI strings, VN shop path fixed (`/products`→`/vn/products`). v4→v8.
- `public/assets/cart.js` — added `window.DXCart` export. v8→v9 (referenced on system pages).
- `public/{,de/,ru/,vn/}system.html` — script version bumps, cart.js added, hero/meta "Four→Seven".
- `PROJECTS/dasexperten-de-website/_devserver.js`, `.claude/launch.json` — local preview tooling (dev-only, untracked, not deployed).
- `SECRETS/cloudflare.md` — token-selection rule updated: **CF Cloud Master = default**, Full Infra demoted (no Pages scope).
- Memory: `cloudflare-default-token.md` (+ index) — the default-token learning.

## Verification (each deploy)
- Live `curl` on `/ru/system`: 7 questions, Q1 = bacteria intrigue, Q3 has no "sink", correct `?v=` refs.
- Preview run-throughs (Chrome MCP): full 7-question paths reach result; buyable→"Добавить пасту в корзину" button adds to cart `{DE201:1}` etc.; non-buyable (Termo/Ginger)→shop link; live map differentiates axes; clue carries forward; 7 progress dots.
- Monte-Carlo distribution re-checked on the merged/live data file.

---

## Known notes / future backlog
- **Brushes are not in the Stripe checkout catalog** (`cart.js` CATALOG has only the 5 buyable pastes). The "system = paste + brush shipped together" promise is delivered as: paste→cart, brush→recommendation/shop link. If brushes get SKUs/prices in checkout, the result can add both in one tap.
- **DE207 BUDDY** has no `paste_result` card — kept as a low secondary weight only (never a winning result). If infant-0+ should be a real result, add a BUDDY result card.
- **BUYABLE set is hardcoded** in `system.js` (`{DE201,DE202,DE205,DE206,DE210}`) and mirrors `cart.js` CATALOG — keep them in sync if the sellable range changes.
- **AXIS_SKUS** (axis→SKU map) hardcoded in `system.js`; map axis labels in `Q.map_axes` per language.
- Pre-existing `*.sync-conflict-*.html` junk files in `public/` (and `public/de|ru|vn`) deploy as stray pages — not created this session; candidate cleanup.
- `pillar` tags from the architect were stripped at merge (engine doesn't use them).
- Sales signal used = WB review counts (real, 14,963+ aggregate). If a true units-sold pull (WB + Ozon) is wanted, weight the distribution against that instead of the review proxy.
