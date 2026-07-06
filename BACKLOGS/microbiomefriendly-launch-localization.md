# Microbiomefriendly Launch Localization — building, localizing & going live the Akkermansia "warm biotech" brand site
<sub>Session dates: 2026-06-04 → 2026-06-07 · (rebuilt from transcript `16c0fe72` after the original backlog failed to sync from another device)</sub>

**Project:** `PROJECTS/microbiomefriendly/public/` → Cloudflare Pages project `microbiomefriendly`
**Live:** https://microbiomefriendly.me · EN at root, RU under `/ru/`, plus `/de/akkermansia`, `/vi/akkermansia`
**Deploy:** `npx wrangler pages deploy public --project-name=microbiomefriendly` (CF Cloud Master token from `SECRETS/cloudflare.md`; account `081ddb85cb399ad62a70210328d744fc`)
**Brand:** Akkermansia / probiotic supplement — a *warm biotech ecosystem brand*, NOT a "shop of jars". Separate project from Das Experten.

---

## TL;DR — what this session did

Took microbiomefriendly.me from an empty domain to a **live, bilingual (EN/RU + DE/VI science pages), conversion-engineered warm-biotech brand site**, built from a design-system handoff. Along the way: migrated DNS to Cloudflare, removed white frames/halos from assets, fixed a recurring contrast bug class, built deep science storytelling pages (Akkermansia AH39, GLP-1), turned "coming soon" journal cards into interactive data-rich modals (EN + RU Faib), wired a real lead-capture backend (Worker + D1), set up a flip-ready Stripe checkout (NOT charging), made the **antisimplicity-rule a global hard rule**, and ended on a **full native-Russian rewrite of the diagnostic quiz** + a mobile layout fix.

Everything below the "DEFERRED" section is **done and live**. The DEFERRED items were explicitly held back pending Aram's go-ahead.

---

## ✅ DONE & LIVE on https://microbiomefriendly.me

### Infra & go-live
1. **DNS → Cloudflare** — zone created in dashboard (CF API tokens lack `zone.create` → did it manually), zone ACTIVE 2026-06-04, proxied CNAME for apex + www. Memory: [[microbiomefriendly-me-cloudflare]].
2. **Full site built from design-system handoff** (`Microbiome Friendly-handoff.zip`, later `…(1).zip`) — static multi-page HTML/CSS/JS, no framework. Deployed to CF Pages `microbiomefriendly`.
3. **Live on apex domain** — promoted from pages.dev to microbiomefriendly.me.

### Design system (locked from updated handoff)
- Navy **#1B3856** (the ONLY navy), ivory #F1EADC, ivory2 #E7DECB, science #FBFAF6, ink #16203A, ink-2 #565E78, line #D9CFBC.
- Fonts: **Bricolage Grotesque** (display) + **Hanken Grotesk** (body).
- Accents: green #2F7D55, gold #C7A24B, violet #6B5CCB, teal #178B7A, coral #E2725B.
- Body baseline: `font-size:16px; line-height:1.62; font-weight:500`.

### Localization
4. **Russian version (`/ru/`)** in **Alexander Faib storytelling voice** (Art of Propaganda style) — built via multi-agent Workflow, with marketolog + conversion-gate + intrigue-lock + segment-check by a separate agent.
5. **DE + VI science pages** — `/de/akkermansia`, `/vi/akkermansia` for that flagship page. Language switcher `.langtog`.

### Visual quality fixes
6. **White frames around bottles + logo micro-tonal halos removed** — jimp flood-fill to transparency (`_tools/cutout.js`, `_tools/logo-cutout.js`). Rule per Aram: zero micro-tonal color differences; either fully remove the image background OR match the segment fill color exactly.
7. **Systematic contrast pass (WCAG)** — deterministic scanner via `preview_eval` (iframe load + computed-style luminance ratio). 0 fails verified repeatedly. Fixed the "blue-on-blue" tag/ghost-button bug (see Errors).
8. **"1–4%" big-number overlap** fixed (reduced clamp size, stacked label).

### Science storytelling pages
9. **`/akkermansia`** — Akkermansia AH39 scrollytelling super-page. Kept manufacturer claims "99.8% protein match" and "−4.27 cm" per Aram ("Нет, это мне нравится").
10. **`/glp1`** — GLP-1 explainer for a lay audience: what synthetic GLP-1 is (Ozempic/Mounjaro context), animated drug-weight-loss bars (semaglutide −14.9%, tirzepatide −22.5%), evidence badges (Lab / Human pilot), comparison table. **Honest framing**: GLP-1 did NOT rise in the human RCT (Depommier 2019) — the mechanism is preclinical P9→GLP-1 + human DPP-IV reduction + insulin sensitivity +28.6%. Built from a full evidence-research Workflow (local clinical PDFs + web grounding, 59 evidence items).
11. **Journal modals** — turned "coming soon" cards into 8 interactive opening windows with big numbers + SVG donut/gauge charts + CTAs + disclaimers. EN (`journal-articles.js`) + **RU Faib** (`journal-articles-ru.js`). Contrast-darkened for AA.

### Conversion / backend
12. **Lead-capture backend LIVE** — Worker `microbiomefriendly-waitlist` (`…workers.dev/save`), D1 `das_erp_dev` (id `0653d156-5069-4c46-a496-fad982d0d1df`), table `mf_waitlist (email,plan,goal,lang,source,ts,ua)`, email-regex validation, CORS for microbiomefriendly.me/www/pages.dev. `window.MF_saveLead(email,opts)` with localStorage fallback. Wired into drawer + quiz save-plan forms. Tested end-to-end OK.
13. **Stripe checkout — flip-ready, NOT charging** — `public/_stripe/` (worker `ENABLED="false"`, `setup.mjs`, `FLIP.md`). Per Aram: "Собрать, но не включать оплату."
14. **Hermes conversion/segment audit applied** — email capture, segment cards, products improvements. (Trust strips / first-batch block held — see DEFERRED.)

### Diagnostic quiz
15. **Quiz rebuilt as a diagnostic scenario** (not a survey) — EN + RU. Engaging opener, live signal map (axes assemble from answers: metabolism, gut–brain, energy, skin, digestion), `?goal=` pre-select, result screen with plan + save-lead.
16. **Full NATIVE-Russian rewrite of `/ru/quiz.html`** — an agent rewrote it in real Russian (Faib voice, no calques) after the prior version was a sloppy machine translation full of mixed-English (routine, vitality, friction, wired-tired, satiety, glow…). `node --check` valid; all JS code/keys/weights/`MF_saveLead`/asset paths preserved; "сток-тест/тест раковины" obscure slang removed.
17. **Mobile quiz-hero overlap fixed** — `@media(max-width:980px){.quiz-hero{grid-template-columns:1fr}.quiz-orbit{display:none}}` — text no longer collides with the orbit ring on phones; gradient boundary moved so the dark bg fully covers the heading. Verified live.
18. **Visible-English cleanup on RU quiz result** — signal-bar axis labels `metabolism/mood/energy/skin/digestion` → Метаболизм/Настроение/Энергия/Кожа/Пищеварение; email placeholder `you@email.com` → `вы@почта.ru`; orbit axis label translated.

---

## ⚙️ FINAL STATE — key files

- `public/css/mf.css` — central shared stylesheet. Dark-context override lists for `.btn--ghost/.pill/.tag/.muted` must include every dark section class (`.hero/.deep/.akk-hero/.g-hero/.cta-band/.mech/.ftr`); article-modal styles (`.artmodal-bg/.artmodal/.artmodal__x`); save-plan single-column + flex input; mobile media queries (`max-width:900px` segments/save-plan, `max-width:980px` quiz-hero).
- `public/js/mf.js` + `public/js/mf-ru.js` — product/strain data + cart + chrome; `MF_saveLead`, `MF_price/MF_sub/MF_money`. (Axis localization for signal bars lives here, NOT in quiz.html.)
- `public/quiz.html` + `public/ru/quiz.html` — diagnostic quiz (Q array: id/axis/q/hook/fact/opts[{l,sub,v,w,reveal}], live signal map, result screen, save-plan → MF_saveLead).
- `public/akkermansia.html`, `public/glp1.html` — science pages.
- `public/js/journal-articles.js` + `…-ru.js` — 8 modal articles each; `public/journal.html` + `public/ru/journal.html` modal system (`data-art`, `openArticle`, scaffold).
- `public/terms.html, privacy.html, faq.html` — legal (faq has `#shipping` anchor).
- `public/_waitlist/worker/` (src/index.js + wrangler.toml) — waitlist Worker.
- `public/_stripe/` — flip-ready checkout.
- Memory: **`antisimplicity-rule.md`** (global hard rule) + added to `CoWork/CLAUDE.md` point 10. SECRETS: `cloudflare.md`, `stripe.md` updated.

**Cache strategy:** assets immutable; css/js `Cache-Control: public, max-age=0, must-revalidate`; asset versioning `?v=N` (currently v=7). Bump `?v=` on every css/js change or pages crash on stale cache.

---

## 🐞 Errors & fixes (so they don't recur)

- **Zone creation 403** — all CF tokens lack `zone.create`; create zones in the dashboard.
- **Contrast "blue-on-blue"** (Aram: "Ты что, дебил, что ли?") — my own `.tag{color:var(--ink)!important}` killed light tag text on the dark mechanism section. **Every new dark section class must be added to the light-text override lists.** This is a recurring trap.
- **Empty products grid / journal "soon"** (Aram: "Почему на этой странице ничего нету?") — **cache-version mismatch**: old cached `mf.js` (no `MF_price`) + new `products.html` → JS crash. Fixed with `?v=N` versioning + `must-revalidate`.
- **GLP-1 accuracy** — research found GLP-1 did NOT rise in the human RCT; reframed honestly (preclinical mechanism vs human DPP-IV). "99.8% protein match" is likely Bifido pH-3 survival, not a protein match — Aram said keep it anyway (manufacturer claim).
- **Over-simplification** (Aram interrupted: "не надо слишком упрощать… на них это всё действует") → reverted to keep 84 kDa, ICAM-2·IL-6, DPP-4 → **created antisimplicity-rule** (now global).
- **Tiny email oval** (Aram circled: "Что это такое?") — save-plan was a 2-col grid squeezing the input; fixed to single column + flex (verified ~239px).
- **Concurrent-edit collisions** — another session (hermes) editing the same repo reverted my edits ("File modified since read"). Aram chose **A**: I take remaining items, the other session stops.
- **Windows `/tmp` path error** for `node --check` temp file — use the project `_tools/` dir, not `/tmp`.
- **Sloppy RU machine translation** — whack-a-mole on mixed-English didn't scale → full native-rewrite agent instead.

---

## ⏳ DEFERRED — held back pending Aram's go-ahead (from the hermes audit)

These were the open "Делать?" items when the session ended (next-step candidates for THIS continuation):

1. **Products comparison table** + **"Best for"** line per card + strain micro-copy.
2. **Trust strip** with **evidence-level labels** ("Lab / Human pilot" tiers) + a **"Read the evidence"** link on Science / AkkerMagic.
3. **"First batch" credibility block** on the homepage.

Recommended approach (matches how the rest of the site was built): multi-agent **Workflow**, EN + RU (Faib) in parallel, through marketolog + conversion-gate + segment-check + **antisimplicity-rule**, then deploy + verify (live curl + Chrome/preview run-through) + bump `?v=`.

### Smaller open notes
- Re-verify the native RU quiz rewrite end-to-end in prod (it was deployed; do a full phone run-through of `/ru/quiz`).
- Confirm signal-bar/orbit axis labels render Cyrillic on the RU result screen (localization source is `mf-ru.js`).

---

**Key refs:** `SECRETS/cloudflare.md`, `SECRETS/stripe.md`; memory: [[microbiomefriendly-me-cloudflare]], [[antisimplicity-rule]], [[cloudflare-default-token]]; transcript `C:\Users\user\.claude\projects\C--Users-user-Documents-CoWork\16c0fe72-5125-4f70-b037-e19e01fed6c6.jsonl`.
