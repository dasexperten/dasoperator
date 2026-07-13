# Chrome · Vault · Clicks

### Session backlog — Operator mobile chrome, analytics vault, dead-click fixes

**Сессия:** 2026-07-13  
**Суть одной строкой:** сделали **das-dashboard / AI-Crawlers UI** дефолтом всего мобильного ERP; задокументировали Design + app icon в **deSIGNER**; SEO/GEO/Ubersuggest dossier в **das-intelligence**; credentials Clarity/GA4/Metrika в **das-architektura/SECRETS**; разобрали **46.7% dead clicks** на `dasexperten.com` и начали фиксы (hero / science / product cards / loyalty).

**3 слова о сути:** **Chrome · Vault · Clicks**

**Файл:** `2026-07-13_chrome-vault-clicks.md`  
**Канон (CoWork):** `C:\Users\user\Documents\CoWork\BACKLOGS\` (копия)  
**Репозитории-якоря:** `dasoperator`, `dasexperten.com`, `das-intelligence`, `das-architektura`, `deSIGNER`

### Разложено по BACKLOGS (loop 2026-07-13)

| Location |
|---|
| `Projects\dasoperator\BACKLOGS\` |
| `Projects\dasexperten.com\BACKLOGS\` |
| `Projects\das-intelligence\BACKLOGS\` |
| `Projects\das-architektura\BACKLOGS\` (local mirror if checkout broken) |
| `Documents\CoWork\BACKLOGS\` (если папка есть) |

---

## 0 · Цель сессии (что хотел owner)

1. **Mobile UI:** стиль AI-Crawlers / das-dashboard → **дефолт всех страниц** мобильного Operator.  
2. **Save / fix** этот UI в `dasoperator` + **иконка** для mobile app.  
3. Все **design / UI / UX** → **deSIGNER** (designer rayboard).  
4. Всё **SEO / GEO / backlinks / organic / Ubersuggest** → **das-intelligence**.  
5. Проверить, что есть по домену в intelligence.  
6. Credentials **Clarity / GA4 / Metrika** сохранить в **das-architektura SECRETS** (не только .com).  
7. Разобрать **TrafficAnalyzer** (не найден) vs реальный traffic stack.  
8. **Dead clicks 46.7%** на `dasexperten.com` — почему и как чинить; начать фиксы.

---

## 1 · DONE — Das Operator mobile chrome

| Item | Status | Where |
|---|---|---|
| Tricolor ribbon under header + above bottom nav | ✅ shipped | `web/components/layout/mobile-shell.tsx` |
| paper-sunk main canvas; paper-raised cards + shadow-card | ✅ | `web/app/globals.css` («MOBILE DAS-DASHBOARD DEFAULT SKIN») |
| Section eyebrows visible; page-level eyebrow above `h1` still hidden | ✅ | globals rule 15 `:has(+ h1)` |
| Bottom nav schwarz + rot active + tricolor top | ✅ | globals |
| Emailer full-bleed opt-out | ✅ | `main:has(.dxmail-page)` |
| Commit | ✅ | `0226907` mobile: das-dashboard UI as default phone chrome |

### Docs (Operator Design)

| File | Status |
|---|---|
| `Design/mobile-ui.md` | ✅ canonical mobile shell rules |
| `Design/das-dashboard.md` | ✅ marked as mobile default |
| `Design/README.md` | ✅ pointer |

### App icon

| Asset | Status |
|---|---|
| Waves on schwarz + top tricolor | ✅ generated |
| `Design/assets/app-icon-1024.png` + squircle | ✅ |
| `web/public/brand/app-icon-{180,192,512,1024}.png`, favicon-32 | ✅ |
| `web/app/icon.png`, `apple-icon.png` | ✅ |
| `web/public/manifest.webmanifest` + layout metadata | ✅ |
| Commit | ✅ | `8821605` Design + mobile: lock chrome and app icon |

---

## 2 · DONE — deSIGNER (design SSOT)

| Item | Status | Commit |
|---|---|---|
| `SYSTEM/das-dashboard.md`, `SYSTEM/mobile-ui.md` | ✅ | `1bfeaae` |
| App icons in `SYSTEM/assets` + `ASSETS/logos` | ✅ | |
| `FOUNDATION/das-operator-mobile.md` | ✅ | |
| `FOUNDATION/mobile-first.md` cross-link ERP vs storefront | ✅ | |
| `GOVERNANCE/corrections-log.md` entries | ✅ | |
| `MASTER_INDEX.md` refresh note; SEO stays out of design | ✅ | |

**Rule:** on design conflict, **deSIGNER wins**. Working copies: dasoperator Design/, das-architektura Design/.

---

## 3 · DONE — das-intelligence (SEO / GEO / domain)

| Item | Status | Commit |
|---|---|---|
| Domain dossier `references/domains/dasexperten.com/` | ✅ | `20a9505` |
| Live Ubersuggest snapshot: **DA 11 · BL 1093 · RD 328 · organic 124** | ✅ | |
| Files: README, site-metrics, ubersuggest, geo-ai-visibility, erp-wire, sources | ✅ | |
| Skills: `ubersuggest-site-pulse`, `geo-ai-visibility` (SEO 16 → 18) | ✅ | |
| MASTER_INDEX + SEO README | ✅ | |
| dig-guide + sources update (analytics vault pointer) | ✅ | `9600e23` |
| BACKLOG `2026-07-13_domain-seo-geo-ubersuggest.md` | ✅ | |

### Hard rules locked

- No fake dashboard metrics (removed DA 26 / linking 164 / backlinks 412 earlier).  
- Numbers only from Ubersuggest / GSC / GA4 / CF.  
- ERP refresh: `POST /api/seo/site-metrics` after each pulse.  
- Outreach: never say “SEO / backlink” in external mail (`partnerships@`).

### Pending (intelligence)

- [ ] Scheduled daily pulse (Grok task → POST ERP → append history)  
- [ ] CF AI Crawl Control when zone API available  
- [ ] GSC API into Operator (site verification)  
- [ ] Clarity AI Visibility export path for ERP  
- [ ] Competitor baselines under `references/domains/competitors/`

---

## 4 · DONE — SECRETS vault (analytics credentials)

### dasexperten.com/SECRETS (also pushed)

| File | Role |
|---|---|
| `web-analytics.md` | Hub dig map |
| `google-analytics-ga4.md` | Property `511756146`, `G-V5J3PZV7ZE`, Worker secrets |
| `microsoft-clarity.md` | Project `wlti3bcscx`, `CLARITY_API_TOKEN`, 10/day |
| `yandex-metrika.md` | LIVE OAuth + token + counters `107720199` / `97012010` |
| `index-secrets.md` | Catalog entries |

**Commit:** `a005e1a` (dasexperten.com)

### das-architektura/SECRETS (owner-requested SSOT)

| File | Role |
|---|---|
| `web-analytics.md` | Merged browser IDs + ERP API map |
| `google-analytics-ga4.md` | New |
| `microsoft-clarity.md` | New (project id + token slot) |
| `yandex-metrika.md` | Refreshed LIVE token + Worker map |
| `index-secrets.md` | Catalog |

**Commit:** `cabe250` on `das-architektura` main (via bare-repo; Windows full checkout still broken on invalid path).

### Gaps (vault honesty)

| Secret | In git vault | In CF Worker |
|---|---|---|
| Metrika OAuth token | ✅ full | ✅ |
| GA4 property ID | ✅ | ✅ |
| GA4_SA_KEY (service account JSON) | ❌ names only | ✅ (do not commit JSON) |
| CLARITY_API_TOKEN value | ❌ paste slot | ✅ |

**Next:** optional R2 `dds-library/KEYS/` backup of SA JSON + Clarity token (never public remotes).

---

## 5 · TrafficAnalyzer

| Finding | Status |
|---|---|
| Repo / skill named TrafficAnalyzer | ❌ **not found** in estate |
| Real stack | Operator `/analytics` (GA4 + Metrika + Clarity), Ubersuggest pulse, intelligence dossier |

---

## 6 · Dead clicks 46.7% (dasexperten.com)

### Diagnosis (done)

Clarity: **% of sessions with ≥1 dead click** (not % of all clicks). Contour often **VN mobile**.

| Cause | Severity | Proposed fix |
|---|---|---|
| Hero image not tappable (only tiny dots) | High | Whole-slide advance on click |
| `.sci-card` non-links | High | Wrap in `<a href="/science#…">` |
| `article.sku` body text non-link until JS | Med–High | Full-card `a.sku-go` stretch |
| Trust chips non-links | Medium | Link to science / products |
| Lang flags dense / small | Medium | Larger tap padding (not done this session) |
| Loyalty popup early + 28px close | Medium | Idle delay + 44px targets |

### Implementation (partial — interrupted mid-commit)

| Change | File(s) | Status |
|---|---|---|
| Hero: click advances; caption → PDP links | `site/com/app.js` | ✅ coded |
| Trust chips → links | `site/com/index.html` | ✅ coded |
| Sci-cards → `/science#enzyme-technology` etc. | `site/com/index.html` | ✅ coded |
| Full-card sku-go CSS + product.js promote | `styles.css`, `product.js`, `products.html` | ✅ coded |
| Quickview: cue button, not whole-card hijack | `quickview.js` | ✅ coded |
| Local loyalty-widget idle 45s / hard 60s + 44px close | `assets/loyalty-widget.js` | ✅ coded |
| EN index/products point to `/assets/loyalty-widget.js?v=2` | index, products | ✅ coded |
| Cache bump styles v32, app.js v14 | index | ✅ |
| Locale HTML / conflicted pages | many `UU` files | ❌ **blocked** by stash merge conflicts |
| **Commit + CF Pages deploy** | — | ❌ **not finished** (user interrupted / dirty tree) |

---

## 7 · Commits reference (this session)

| Repo | SHA / note |
|---|---|
| dasoperator | `0226907` mobile chrome; `8821605` icon + Design docs |
| deSIGNER | `1bfeaae` Operator mobile + icon SSOT |
| das-intelligence | `20a9505` domain dossier + skills; `9600e23` dig-guide |
| dasexperten.com | `a005e1a` SECRETS web-analytics; **dead-click code uncommitted** |
| das-architektura | `633db3f` Design mirror; `cabe250` SECRETS analytics vault |

---

## 8 · ПЛАН ДЕЙСТВИЙ — что не успели (rewrite 2026-07-13)

> Цель: довести до **live** то, что уже написано локально, измерить dead clicks,  
> закрыть vault-дыры и SEO-pulse. Без расползания scope.

### Фаза A — Unblock git + ship EN dead-click fix (P0, сегодня / следующая сессия)

**Блокер:** `dasexperten.com` ≈ **154 unmerged** locale HTML после stash pop.  
**Нельзя** `git add -A` / force-merge всего дерева.

| # | Действие | Как | Готово когда |
|---|---|---|---|
| A1 | Сбросить конфликтный индекс, **не трогая** наши файлы | `git checkout origin/main -- .` + re-apply 7 files | ✅ 2026-07-13 UU=0 |
| A2 | Закоммитить **только** intentional package | 7 files + B1 lang padding | ✅ **`018fb48`** on main |
| A3 | **Не** включать `reviews.js` и чужие staged diffs | only 7 files in commit | ✅ |
| A4 | Deploy Pages **direct-upload** (NOT git auto) | `wrangler pages deploy site/com --project-name=dasexperten-com` | ❌ **BLOCKED** — all vault CF tokens return auth 10000 / 9109 (need rotate **CF Cloud Master**) |
| A5 | Smoke live | after A4 | ⏳ pending deploy |

**Smoke checklist (A5)**

- [ ] `/` — tap hero photo → next slide (not dead)  
- [ ] `/` — tap product name on hero caption → PDP  
- [ ] `/` — sci-card 01/02/03 → science anchors  
- [ ] `/` — trust chips → science/product  
- [ ] `/products` — tap card body (not button) → PDP; Add to cart still works  
- [ ] Quick view cue still opens drawer  
- [ ] Loyalty popup not in first 15s; close button ≥44px  
- [ ] No `<<<<<<<` in any deployed HTML  

---

### Фаза B — Dead clicks: добить UX (P1, 1–2 дня после A)

| # | Действие | Детали | Done |
|---|---|---|---|
| B1 | **Lang flags** — 44px tap without breaking one-row freeze | CSS only: padding on `.ribbon .lang a`, not wrap | [ ] |
| B2 | **Locales high-traffic** (`/vn/` first — Clarity VN-heavy) | Same sci-card/trust/hero JS is global (`app.js`); ensure locale index uses shared `app.js`/`styles.css` cache-bust; HTML sci-card markup only if duplicated in locale index | [ ] |
| B3 | Loyalty SSOT | Decide: keep `/assets/loyalty-widget.js` **or** publish same file to `loyalty.dasexperten.com/widget.js` so all 280+ embeds get fix without HTML rewrite | [ ] |
| B4 | If B3 = loyalty host | Deploy widget to loyalty Pages; leave EN local `?v=2` as fallback | [ ] |
| B5 | Cart badge “2” | Remove fake badge or wire real cart count | [ ] |
| B6 | Clarity re-measure | Project `wlti3bcscx` · Dead clicks filter · **3–7 days** after A4 · compare to 46.7% baseline | [ ] |
| B7 | Top dead selectors after fix | Export / screenshot top elements; open new tickets only if residual >20% sessions | [ ] |

**Acceptance B:** dead-click session share **↓ materially** (target &lt;25% soft, stretch &lt;15% on mobile VN).

---

### Фаза C — Analytics vault complete (P1)

| # | Действие | Где | Done |
|---|---|---|---|
| C1 | Export **Clarity** Data.Export token once | clarity.microsoft.com → `wlti3bcscx` | [ ] |
| C2 | Confirm Worker has `CLARITY_API_TOKEN` | `dasoperator` API Worker secrets | [ ] |
| C3 | Optional private backup | R2 `dds-library/KEYS/` (not git) + note in `SECRETS/microsoft-clarity.md` “backup: R2” | [ ] |
| C4 | Confirm `GA4_SA_KEY` still valid | smoke `GET /api/ga4/overview?days=7` via ERP session | [ ] |
| C5 | Optional SA JSON backup | same R2 KEYS path; **never** commit to git | [ ] |
| C6 | Metrika token TTL | note expiry ~332d from 2026-06-11 → calendar reminder ~2027-05 | [ ] |

---

### Фаза D — SEO / domain pulse automation (P2)

| # | Действие | Где | Done |
|---|---|---|---|
| D1 | Grok scheduled task or CF cron: Ubersuggest `domain_overview` + `backlinks_overview` | daily or 3×/week | [ ] |
| D2 | `POST /api/seo/site-metrics` with DA/BL/RD/organic | ERP KV | [ ] |
| D3 | Append row to `das-intelligence/.../site-metrics.md` history | intelligence | [ ] |
| D4 | Skill runbook already exists | `skills/seo/ubersuggest-site-pulse` — use it | [ ] |
| D5 | GSC API / site verification | Operator home “Google Search panel” still pending | [ ] |
| D6 | CF AI Crawl Control | when NS/API ready; until then keep `· demo data` on AI Crawlers | [ ] |

---

### Фаза E — Operator polish (P3, only if A–B green)

| # | Действие | Done |
|---|---|---|
| E1 | Home AI Crawlers block: re-enable only with real CF numbers or explicit demo marker | [ ] |
| E2 | ERP `/api/clarity/*` 404 from unauth — confirm route still under AuthGate (OK); document dig path = ERP UI login | [ ] |
| E3 | Mirror any new Design tokens from dead-click CSS into deSIGNER only if brand-level (not storefront one-offs) | [ ] |

---

### Порядок на следующую сессию (строго)

```
A1 ✅ → A2 ✅ → A3 ✅ → A4 ⛔ (CF token) → A5 ⏳
B1 ✅ (in 018fb48) · B3 still open
     ↓ after A4
B2 (vn) → B6 (wait 3–7d) → B7
     ↓ parallel
C1–C6 vault · D1–D4 SEO pulse
     ↓ later
D5–D6 · E1–E3
```

### ⚡ Immediate unblock for A4

1. Cloudflare Dashboard → My Profile → API Tokens → create/rotate **CF Cloud Master**  
   (Account: Cloudflare Pages Edit + Account Settings Read at minimum).  
2. Paste into `SECRETS/cloudflare.md` (das-architektura + dasexperten.com).  
3. Run:

```bash
cd Projects/dasexperten.com
export CLOUDFLARE_API_TOKEN='…new…'
export CLOUDFLARE_ACCOUNT_ID=081ddb85cb399ad62a70210328d744fc
npx wrangler pages deploy site/com --project-name=dasexperten-com --branch=main
```

Or: `DAS_ARCH=… tools/deploy.sh` after token fix.
### Do / Don’t

| Do | Don’t |
|---|---|
| Commit 7 intentional files only | `git add -A` with 154 UU locales |
| Deploy after smoke | Ship HTML with `<<<<<<<` |
| Measure Clarity after ≥3 days | Claim dead-click fixed from 1 hour data |
| Keep Metrika/GA4/Clarity contours separate | Blend volumes into one “traffic” number |
| deSIGNER for design; intelligence for SEO numbers | Put SA JSON in public git |

### Open questions (need owner only if blocking)

1. **Loyalty:** main-site `/assets/loyalty-widget.js` as SSOT, or republish to `loyalty.dasexperten.com`? (Recommend: **republish** so all locales get idle popup without 280 HTML edits.)  
2. **Hero:** keep “tap = next slide” (current code) or change to “tap = open PDP”?  
3. **46.7% window:** confirm 1d vs 3d in Clarity for baseline.

---

## 9 · Owner decisions / constraints remembered

- Mobile ERP language = **das-dashboard** only; no second mobile design.  
- Design SSOT = **deSIGNER**; metrics SSOT = **das-intelligence**; secrets SSOT for estate = **das-architektura/SECRETS**.  
- Never invent DA / crawler / session numbers.  
- Mail: **@dasexperten.com** only; virtual staff not founder.  
- Flags row on .com frozen one-line (pad hits, don’t reflow).  

---

**END — Chrome · Vault · Clicks**
