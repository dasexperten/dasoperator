# Das Operator ERP — Infrastructure Inventory

Everything the system runs on. **No secret values here** — token *names* only;
real values live in `das-architektura/SECRETS/` (per-program `.md` files) and are
mirrored to R2 `dds-library/KEYS/`.

---

## Cloudflare account

- **Account ID:** `081ddb85cb399ad62a70210328d744fc`
- **Plan:** Workers Paid

## Compute

- **Worker (API):** `dasoperator-api.dasexperten.workers.dev` — single Hono
  Worker exposing the ERP REST API. Deploys via **GitHub Actions on push to
  `main`** (~90–120s).
- **Frontend (Pages):** `dasoperator.pages.dev` — Next.js 14 static export.
  Deploy via direct `wrangler pages deploy` (git-trigger unreliable — see below).
- **Loyalty frontend (Pages):** `das-bonus` → `bonus.dasexperten.ru` (CNAME at
  Reg.ru, manual).
- **Shared workers:** `emailer-bridge.dasexperten.workers.dev` (outbound email +
  Apps Script proxy — always route email through this, never curl Apps Script
  directly; sandbox TLS inspection blocks it), `apify-bridge` (scraping).
- **Future custom domain:** `erp.dasexperten.com` (deferred).

## Data

- **D1:** `das_erp_dev` — UUID `0653d156-5069-4c46-a496-fad982d0d1df`, region
  East Europe (EEUR). Worker binding `env.DB`. Applied migrations: 0001 → 0057
  (60 files). Dev-only environment at this stage.
- **R2:** `das-erp-docs-dev` (invoices, contracts, packing lists, product photos,
  `email-canon/`), `das-pricelists` (price-list files). Binding `DOCS`.
- **KV** (namespace `43f2004892714cbb919e5174ce2a8556` group):
  `das-counters` (sequential numbers), `das-fx` (daily FX), `das-cache`
  (short-TTL cache).

## Cron schedule

| Schedule | Job |
|---|---|
| `0 12 * * *` UTC | Daily FX refresh (CBR/ECB → `das-fx`) |
| `5 */6 * * *` UTC | Ozon Performance CPC sync |
| every 6h | Marketplace feeds refresh (reviews/questions) |
| every 15 min | Telegram invoice inbox ingestion |
| every 10 min | Watchdog (`v_health` → Telegram escalation ≤ 1/3h) |
| nightly | inbox-reconcile three-way deal builder |
| hourly | WB review-reply backlog drain |
| — | `/api/cron/auto-delivery` |

## Integrations

- **Marketplaces:** Ozon Seller + Ozon Performance (CPC), Wildberries (WB Seller +
  isolated WB reviews token).
- **Banking:** Modulbank DEE (webhook + hourly cron). VTB (manual CSV import —
  УНЭП signature can't run on Workers). Wio Bank AED+USD for DEI (API awaiting
  approval, request sent 2026-05-08).
- **CRM / Loyalty:** Yandex KIT (loyalty webhook `ORDER_STATUS_CHANGED`),
  Yandex Pay (finance flow → `DASR-YYYYMMDD`), Yandex Metrika (counter
  107720199). RetailCRM — **exited** 2026-06-12 (loyalty in-house).
- **Email:** Gmail (via Apps Script / emailer-bridge), Resend (rumailer-bridge,
  outbound .ru), Telegram (inbox + bot notifier).
- **LLM providers:** Anthropic (primary), DeepSeek (fallback), OpenAI/GPT-5.5
  (ChatGPT OAuth for reviews), Gemini, Qwen — routed in `api/src/lib/llm.ts`.
- **Docs:** CloudConvert (docx → PDF).

## Token inventory (names only — values in SECRETS/)

- GitHub PAT · CF Workers Edit · CF Full Infra · CF D1 Admin · CF Pages/Cloud
  Master (used for all deploys)
- `DEEPSEEK_API_KEY` · Anthropic key · OpenAI/GPT · Gemini
- Ozon Client-Id + Api-Key · Ozon Performance Client-Id + Client-Secret
- `WB_API_TOKEN` + `WB_API_TOKEN_REVIEWS`
- `MODULBANK_TOKEN_DEE` · `RESEND_API_KEY` · `YANDEX_KIT_TOKEN` + `KIT_WEBHOOK_TOKEN`
- Admin bearer secret for `/admin/*` endpoints
- Telegram `BRIDGE_SECRET` / userbot session (see SECRETS/telegram-*.md)

> ⚠️ The original claude.ai project description stored some tokens in cleartext
> and an OAuth `client_secret_*.json` + a "GitHub Actions deploy" token were
> attached to the project — flagged for rotation / removal in `_PROJECT.md`.
> Do not reintroduce secret values into this repo.

## Deploy protocol (the reliable path)

**Worker (`api/**`):** push to `main` → GitHub Actions builds & deploys.

**Frontend (`web/**`):**
```
cd web
npx @cloudflare/next-on-pages@1.13.12 build
npx wrangler pages deploy .vercel/output/static \
  --project-name=dasoperator --branch=main --commit-dirty=true
```
CF Pages git-trigger sometimes reports success but serves stale HTML (chunk
filenames absent on CDN) — the direct `wrangler` upload is the trusted route
(BACKLOG item N).

**D1 migrations:** applied directly to prod via the Cloudflare D1 REST API from
the authoring session (or `wrangler d1`). Append-only; no `ALTER COLUMN` — full
table recreation for constraint changes, copying CHECK/FK/indexes 1-for-1.
