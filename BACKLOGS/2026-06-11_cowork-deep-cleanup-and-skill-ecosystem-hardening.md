# CoWork Deep Cleanup & Skill-Ecosystem Hardening

**Session date:** 2026-06-11
**Owner:** Aram (process architect) · executor: Claude
**One-line:** Full-folder hygiene pass on CoWork — restructure KNOWLEDGE/CASES, kill duplicates, fix the SKILLS gate graph, audit triggers, lock the image-engine policy, and stand up an agent layer — leaving the system with zero broken gates, zero duplicate SKILL.md, and self-checking reference mirrors.

---

## 1. Goal (as set)

Series of requests across the session, each building on the last:
> 1. «Сделай полную оценку папки CoWork — как она структурирована. KNOWLEDGE — как переструктурировать? CASES — что хорошо, что менять?»
> 2. «Слей twin-папки. SECRETKEY.PSW → SECRETS. Выполни реструктуризацию.»
> 3. «Проверь SKILLS: совместимость, гейты, взаимодействие.»
> 4. «Создай недостающие гейты legalizer-customs, logist-freight.»
> 5. «Найди дубли по всему CoWork, удали лишние (заменяемое — последнее; дополняющее — слить).»
> 6. «Проверь триггеры vs возможности скиллов. Предложи и создай агентов на базе скиллов.»
> 7. «Для генерации картинок — только Gemini и AtlasCloud, не Higgsfield.»
> 8. «Исправь все остатки.»

---

## 2. Delivered — by block

### 2.1 Root & KNOWLEDGE restructure
- **Twin PROJECTS folders merged:** `Das Operator ERP` → `Das-Operator-ERP` (anthropic-bridge moved in), `VISION CODER` → `VISION-CODER`. Husks removed.
- **SECRETKEY.PSW** moved `KNOWLEDGE/EMEA` → `SECRETS/` (a password was readable by every skill scanning KNOWLEDGE).
- **KNOWLEDGE split by role** (mirrors SECRETS discipline) + `_INDEX.md` catalog:
  - `RECORDS/` — knowledge-records (instruction re-pointed here)
  - `REFERENCE/` — master-guideline, ugc-blogger-db, science-blocks, SEO xlsx
  - `DOCS/` — `ENTITIES` (30), `CONTRACTS` (49 after dedupe), `LOGISTICS` (33), `CERTIFICATES` (42 after dedupe)
  - `_archive/` — superseded duplicates
- **PERSONAL/** created at root: `HEALTH/` (cardiology, genome, blood tests, grief book) + `IDENTITY/` (passport) — pulled out of KNOWLEDGE so business skills can't load private medical files into context.

### 2.2 CASES
- Protocol (`README.md`) is well-designed; folder was 90% squatters → cleaned.
- loyalty project → `PROJECTS/loyalty-program/`; runbooks → `Reference & Protocols/`; 8 legal PDFs → `KNOWLEDGE/DOCS/CONTRACTS/`; personal docs → `PERSONAL/`.
- Naming rule changed `topic.md` → **`YYMMDD-topic.md`** (collision-proof); `_INDEX.md` ledger added.
- **macOS home-dir skeleton deleted** (Desktop/Library/Music/Pictures/.nvm — leaked via mis-mapped Syncthing share). `.stignore` added in CASES + root (node_modules, dist, .DS_Store) to stop re-sync.

### 2.3 Duplicate sweep (~110 MB freed, ~45 files)
- Hash-scan across CoWork (excl. node_modules/Library/_archive). Deleted exact byte-copies (kept latest/named version): contract (1)/(2) copies, 10 GTD/declaration dupes (kept named `щетки`/`пасты`), pricer price-list copies, old `sales-hunter-SKILL.md`, root SKILLS PNGs, M2 character dupes, 8 Syncthing sync-conflict files, .bak landing, identical `INBOX/seo-master`.
- **Merged complementary:** 3 Chinese YANGZHOU folders → 1 (16 unique layouts, 6 rescued); microbiomefriendly `_handoff` dropped for fuller `_handoff2`.
- **Key fix surfaced:** BUYER_DATABASE & SERVICE_PROVIDERS lived only in KNOWLEDGE but legalizer looked in its own `references/` → gates `legalizer-buyer`/`legalizer-provider` were dead. Moved the bases into the skill; stale CERTIFICATIONS/RPP copies in KNOWLEDGE deleted (live ones in legalizer/pricer are newer). `_INDEX.md` now points to skill-owners.

### 2.4 SKILLS gate graph
- Built full caller→target gate map. Core is healthy: hub model (product-skill ×12, benefit-gate ×8, imager ×8, apifier ×7, contacts ×7) works as designed.
- **Broken gates fixed:** `moviemaker`→`animator`, `conversion gate`→`benefit-gate` (designer), example-syntax false-positive in skill-auditor neutralized.
- **Created two missing sub-gates:**
  - `GATE: legalizer-customs` (in legalizer) — duty/VAT by country + fixed HS codes (3306.10/.20/.90, 9603.21); source order: internal GTDs → official tariff portals → apifier; hard no-invented-rates + sanctions overlay; signals VERIFIED/INDICATIVE/UNAVAILABLE.
  - `GATE: logist-freight` (in logist) — $/unit freight by country; order: actual shipments → forwarder quotes → market indices w/ container-to-unit formula; same signal triad.
  - pricer/RPP_reference updated to handle the three return signals.

### 2.5 Triggers
- 406 trigger phrases scanned; collisions minimal. Fixes applied:
  - animator bare `отзыв` → `видео-отзыв` (was colliding with review-master)
  - valera ⇄ dater-skill PRIORITY RULE added (valera = flirt reply, dater = scoring/analysis)
  - ozon-skill `поставка`/`остатки` → `поставка на озон`/`остатки озон` (freed logist's territory)
  - apifier stripped greedy words (browse, watch, research, Find out, Поищи)
  - brush-zoom → deprecated redirect stub to bannerizer (module verified embedded; triggers + legacy `[[GATE]]` preserved)

### 2.6 Image-engine policy locked
- **imager** description: Das Experten images = Gemini (default pipeline) OR atlascloud gate (nano-banana-pro, native Cyrillic). **Higgsfield NEVER for images.**
- **higgsfield-generate**: NOT for Das Experten images of any kind — video backend only (via motionizer/animator).

### 2.7 Agent layer (`.claude/agents/` + mirrors in skill folders)
Six agents created:
- **prospector** (sales-hunter) — autonomous B2B hunt, 5+ qualified leads, stop-rule, sanctions hygiene
- **knowledge-recorder** (record protocol) — source → KNOWLEDGE/RECORDS, double number-check
- **review-batcher** (review-master) — batch reviews → answers, 🔴 escalation on legal-risk
- **doc-pack-builder** (invoicer) — CI+PL one-shot via contacts/pricer/legalizer-compliance, hard stop on missing identifiers
- **case-writer** (CASES protocol) — incident → case files + _INDEX.md update
- **skill-auditor** (skill-creator) — periodic read-only ecosystem health check

### 2.8 Phantom gates wired (final pass)
- 13 outbound gate calls added so declarations are now real: telegramer (4 callers), seo-master (4), virality-master (6), motionizer (7), emailer (8). Each with channel rules (cold-limits, pre-send confirmation, pre-screen).
- 6 stale May `*-SKILL.md` snapshots deleted (contacts, daily-digest, legalizer, logist, personizer, ugc-master).
- index-skills.md actualized: 53 skills, seo-master added, brush-zoom marked deprecated.

### 2.9 Reference-mirror checker
- `SKILLS/skill-creator/scripts/check-reference-mirrors.py` — verifies ingredients/clinical-data/sku-data/segment-check/AVF copies across product-skill/technolog/review-master/das-presenter/bannerizer/marketolog/blog-writer via diff (canon = product-skill).
- Immediately caught drift: `sku-data.md` mirrors had packaging column stripped → re-synced from canon. Wired into skill-auditor checklist.

---

## 3. Final verification state

- **Broken gates:** 0 ✅
- **Duplicate SKILL.md:** 0 ✅
- **Folders without SKILL.md:** 0 ✅
- **Reference mirrors:** synchronized ✅
- **CASES:** clean (README, _INDEX, case-writer, 1 real doc) ✅
- **Disk freed:** ~110 MB

---

## 4. Open / carry-forward

- [ ] **Syncthing mis-map (root cause):** a device's Cases share points at a home directory — that's what leaked the macOS skeleton. Fix the share mapping on PC/Mac so it can't recur; root `node_modules`/`dist` still sync unless `.stignore` honored everywhere.
- [ ] **hermes_ed25519 confirmed OK** — keys are 432B/114B (not empty; earlier 0-byte report was a KB-rounding artifact). 3 consistent sources: SECRETS, HERMES/ssh, inline in hetzner.md/vision-coder-protocol.md. No action.
- [ ] **higgsfield-product-photoshoot / -marketplace-cards** live in the plugin (not CoWork/SKILLS) so their descriptions can't be locally edited — image-policy protection done from the owner side (imager/productcardmaker declared owners). Revisit if plugin updates.
- [ ] **Schedule skill-auditor** weekly (cron via schedule skill) so gate/trigger/dupe/mirror drift is caught automatically instead of by hand.
- [ ] **Agents activate next session** — `.claude/agents/` is read at session start; confirm prospector/knowledge-recorder etc. show up and smoke-test one.
- [ ] **DEASEAN_Charter_Capital_Reduction_Package.docx** sits in CASES root — decide if it's a real case (wrap in YAML per protocol) or belongs in KNOWLEDGE/DOCS.

---

## 5. Files touched (high-level)

- Moved/restructured: KNOWLEDGE/* , PERSONAL/* (new), CASES/* , PROJECTS twins, SECRETS/SECRETKEY.PSW
- Edited skills: legalizer, logist, pricer, imager, higgsfield-generate, animator, valera, dater-skill, ozon-skill, apifier, brush-zoom + 13 with new outbound gates
- New: 6 agents (.claude/agents/ + skill mirrors), KNOWLEDGE/_INDEX.md, CASES/_INDEX.md, .stignore ×2, check-reference-mirrors.py
- Catalog: SKILLS/index-skills.md actualized

**Last updated:** 2026-06-11
**Owner:** Aram Badalyan / Das Experten
