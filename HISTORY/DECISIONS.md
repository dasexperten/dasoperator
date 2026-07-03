# Das Operator ERP — Decisions & Business Rules

Consolidated from the two ADRs (`../docs/decisions/`), the session notes, and the
project memory. Two layers: **architecture decisions** (the how) and **cemented
business rules** (the what — the domain laws the system must never break).

---

## Architecture decisions (ADRs)

### ADR 001 — D1 vs Skills as source of truth *(2026-05-02, Accepted)*
Hybrid model (Variant Z):
- **D1** holds operational master data (companies, partners, products, prices,
  warehouses, operations, line items, documents, inventory, sequences, FX).
- **Skills** hold the knowledge layer (clinical data, INCI, contract templates,
  brand voice, sales playbooks, sanctions results).
- **Reference data syncs daily** from skill markdown into D1 (03:00 UTC worker);
  critical changes (banking, legal names) alert Aram via emailer.
- **PDFs/binaries live in R2**, never D1 — D1 stores only the URL reference.
- Rejected: skills-as-truth+D1-cache (slow aggregation), D1-as-sole-truth
  (breaks skill portability in chat).

### ADR 002 — D1 schema conventions *(2026-05-02, Accepted)*
1. **TEXT slug primary keys** (`cmp_dee`, `prt_torwey`, `DE201`) — readable,
   export-safe, aligned with skill markdown filenames.
2. **Money as INTEGER minor units** (890.00 RUB → `89000`) — no float error.
3. **Dates as INTEGER unix timestamps** — sort = chronology, UTC by convention.
4. **FX rates as INTEGER × 1,000,000** — 6-dp precision without float.
5. **Soft delete via `deleted_at`** — audit trail; never physical DELETE.
6. **`created_at` + `updated_at`** on every table.
7. **FK `ON DELETE RESTRICT`** by default; CASCADE only for `line_items`→
   `operations` and `inventory_items`→`inventory_sessions`.
8. **Enums as TEXT + CHECK** — no join, Drizzle type-safe.
9. **Flexible attributes as JSON in TEXT** — `json_extract`/`json_set`; promote
   hot fields to real columns.

Corollaries that bit later: no `ALTER COLUMN` in D1 → full table recreation for
constraint changes; `schema.ts` synced by hand; migrations append-only.

---

## Decisions locked in later sessions

- **Warehouse ID rule** — `id = lowercase(code)`, bare lowercase, no prefixes.
  (Forced `han`→`swh`, `gzh_bw`→`dgn`.) *(2026-05-09)*
- **Partner abbreviation rule** — 2–6 uppercase chars, UNIQUE, set manually;
  used in contract numbering `DEE-{ABBR}-{YYYY}-{NNN}` and R2 filenames
  `contracts/<company>/<ENTITY>-<ABBR>-<DATE>.pdf`. *(2026-05-09; relaxed from 4)*
- **Contract-number integrity** — never fabricate a contract number. Numbers are
  free-text copied from the actual paper. Legacy odd formats (`01112023`,
  `Bl-A 1301`, `DEI2601`) are kept as-is, never renumbered. Placeholders stay as
  `NO-CONTRACT-{partner_id}` (dashed pill in UI) until a real document is signed.
- **Partners list field semantics** — `contract_no`/`contract_date` on the
  partners endpoint derive from the contracts table (earliest active main via
  `ROW_NUMBER()`), with COALESCE fallback to legacy columns.
- **Document language** — decided seller-side (issuer), not buyer-side.
  *(migration 0030)*
- **Bank matching 3-state** — Matched / Pending (INN with history) / Assign (INN
  unknown); invoice-number pre-classifier runs first; acceptance filename
  (`Акт|Act|УПД|upd`) overrides the LLM classification.
- **Payment state source** — always read `v_operation_payment_status` (sums
  payments + `bank_transactions.matched_operation_id`), never ad-hoc.
- **Money sanity-check** — query `v_money` before quoting any sum; cite
  `amount_correct`; stop on `range_check` huge/tiny.
- **Inbox conservative profile** — no auto-create on unknown partner or uncertain
  classification; separate operation per invoice line; `sale_payment` →
  `payment_pending` (amber dot). WATCHLIST senders bypass the classifier →
  `needs_review`.
- **Deploy protocol** — CF Pages git-trigger is unreliable; the reliable path is
  `npx @cloudflare/next-on-pages build` then direct
  `wrangler pages deploy .vercel/output/static --project-name=dasoperator
  --branch=main --commit-dirty=true`. Worker deploys via GitHub Actions on push.
- **LLM routing** — primary Anthropic (`callPro`→sonnet, `callFlash`→haiku);
  DeepSeek fallback only on 429/5xx/network. Reviews reply chain: GPT-5.5
  (ChatGPT OAuth) → DeepSeek → Claude OAuth. Ozon `/v1/analytics/data`
  sequential, never parallel.

---

## Cemented business rules (domain laws)

**Legal entities & document roles**
- Four entities: **DEE** (Russia/VTB), **DEI** (UAE/Sharjah), **DASEAN**
  (Vietnam), **DEC** (holding, no document role).
- УПД / ТН — **DEE only**. DEE issues CI+PL to non-Russian buyers. DEI/DASEAN
  issue CI+PL to anyone. DEI passthrough (`dei_layer`) = two document packages.
- Each seller has its own stamp/signature: DEI (`dei_stamp_signature.png`),
  Jinxia (round + Lois Guan), Honghui (oval + Ellen Wei), WDAA (HK chop + Ellen Wei).

**Currency**
- DEE ↔ Chinese factory (direct) = **CNY** (VTB Shanghai yuan).
- DEI ↔ anything = **USD**. Any chain via DEI as intermediary = **USD**.
- Meizhiyuan ↔ anyone = **USD** (its export setup).

**Operations & references**
- Reference `<PARTNERABBR>-YYMMDDXX` (e.g. `TORW-260302-01`); Entity = buyer.
- Status is direction-aware; delivery/fulfilment is a separate dimension.
- Transfer batches group `F4-WH-R` ops by (date, marketplace) under
  `OZN-/WB-YYMMDD` parents.

**Marketplaces**
- WB token split: `WB_API_TOKEN` (statistics/prices/common) vs
  `WB_API_TOKEN_REVIEWS` (feedbacks-api, isolated in `wb-reviews.ts`) — never mix.
- WB revenue = `priceWithDisc`, not `finishedPrice`.

**Money & banking**
- `bank_transactions.amount` = MINOR cents; `operations.total_amount`,
  `payments.amount`, `line_items.unit_price` = DECIMAL major. Do not confuse.

**F4 Lubertsy**
- Partner `f4_lubertsy` and warehouse `LBR` are one legal entity (ИП Швалев
  Андрей Сергеевич, INN 550412856773) seen from two views — operational
  (warehouse) and legal/financial (partner for payments).

---

## Standing UI / design rules

- Font min **14px** everywhere; **letter-spacing never > 0**; Manrope 14px+
  instead of dx-mono/dx-eyebrow.
- Bold columns: Operations (Reference/Partner/Total), Products (SKU/Name),
  Partners (Country/Net Debt). All numerics `font-weight: 700`.
- USD shown as whole numbers only: `$128`, `$42K`, `$5M`. No quotation marks in prose.
- Placeholder contracts as dashed pills; partner code as bold 2–6-letter pill.

---

## Hard operating principles (scars → rules)

- **No autonomous data-modeling / taxonomy / schema changes beyond an explicit
  request** — there was a recorded incident.
- **Never overwrite a file edited between read and write** — fetch a fresh SHA
  immediately before every GitHub PUT.
- **Never fabricate** a contract, IBAN, INN, token, or ID.
- **Cross-chat coordination is law** — a message about DB/infra/schema from
  another chat is binding; UI may be simpler than the DB, the DB is never
  simplified to fit the UI; on table recreate, copy constraints 1-for-1.
