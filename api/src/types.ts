// =============================================================================
// Cloudflare Worker bindings — must match api/wrangler.toml
// =============================================================================

export interface Env {
  // D1 Database — operational source of truth (Phase 1.1, 1.2)
  DB: D1Database;
  ARCHIVE: R2Bucket;
  ARCHIVE_OLD?: R2Bucket;   // das-operator-data — email archive harvest

  // R2 Bucket — document storage (Phase 1.3)
  // Stores PDFs (CI/PL/contracts), photos, certificates
  DOCS: R2Bucket;

  // R2 Bucket — pricer skill markdown files (Phase 5.1-pricer-r2)
  // Source of truth for product prices. Read by /api/products/:id/price endpoint.
  PRICELISTS: R2Bucket;

  // R2 Bucket — das-skills (Reviews v5 — review-master pipeline)
  // Stores all 6 skills (review-master, product-skill, technolog, marketolog,
  // benefit-gate, legalizer) with their references. Cached via KV CACHE.
  // Source of truth for the review-master 6-gate pipeline.
  SKILLS_BUCKET: R2Bucket;

  // KV Namespaces (Phase 1.3)
  COUNTERS: KVNamespace;  // sequences cache (DEE-001, CI-202605-0001 etc)
  FX: KVNamespace;        // daily FX rates snapshot
  CACHE: KVNamespace;     // generic ERP cache (hot lookups, sessions)

  // Service Binding — emailer-bridge Worker (Phase 9.x — inbox cron)
  // Required because Cloudflare blocks same-account Worker→Worker calls
  // via public *.workers.dev URLs (error 1042: "loop"). Service bindings
  // route in-process, no HTTP overhead.
  EMAILER: Fetcher;

  // Service Binding — SELF (this same worker, for cron→route calls)
  // Required for the same Cloudflare loop reason as EMAILER. The cron
  // scheduled handler uses env.SELF.fetch() to invoke our own POST
  // /api/marketplaces/sync/* routes — public *.workers.dev would 1042.
  SELF: Fetcher;

  // Cloudflare Email Sending (Beta) binding — outbound transactional email
  // from notify.dasexperten.com. See src/services/email.ts for the allowed
  // sender addresses and send/validation logic. NOT to be confused with
  // EMAILER (Apps Script/Gmail bridge for .de human-facing mail) or Email
  // Routing on dasexperten.com (inbound forwarding) — three separate systems.
  EMAIL: SendEmail;

  // Shared secret gating POST /api/email/test until Bearer-session admin
  // auth is wired to this endpoint too. Set via: wrangler secret put
  // ADMIN_EMAIL_TEST_SECRET. Send it as header X-Admin-Email-Test-Secret.
  ADMIN_EMAIL_TEST_SECRET?: string;

  // Resend API key (restricted, send-only) for human-facing replies from the
  // Emailer UI. Verified sending domain: send.dasexperten.ru.
  RESEND_API_KEY?: string;

  // Secrets (Phase 5.x — LLM integration)
  // Set via Cloudflare Workers secrets, never committed to repo.
  DEEPSEEK_API_KEY: string;

  // Gemini API for rating-only review replies (hybrid pipeline)
  GEMINI_API_KEY: string;

  // Qwen (Alibaba DashScope, intl) — rating-only review answers (qwen-max).
  // Set via: wrangler secret put DASHSCOPE_API_KEY
  DASHSCOPE_API_KEY?: string;
  // OpenRouter ERP contour key — see SECRETS/openrouter.md (ERP_API).
  // Set via: wrangler secret put OPENROUTER_ERP
  OPENROUTER_ERP?: string;

  // ⚠️ DEPRECATED (2026-05-28): no code path reads this anymore.
  // The ERP's only Anthropic transport is OAuth (CLAUDE_CODE_OAUTH_TOKEN).
  // Pay-as-you-go Anthropic is intentionally NOT a fallback — DeepSeek V4-Pro
  // is the sole fallback, routed via api/src/lib/llm.ts. This field is kept
  // in the interface so that the Worker secret binding remains valid and
  // can be removed via Cloudflare dashboard at Aram's discretion.
  ANTHROPIC_API_KEY?: string;

  // Claude Code OAuth token (sk-ant-oat01-*) — Max 20x subscription quota.
  // PRIMARY (and only) Anthropic credential used by the ERP.
  // Used by api/src/lib/anthropic.ts. Generated via `claude setup-token`,
  // expires 1 year after issue (current token 2026-05-27 → 2027-05-27).
  // ROTATION: re-run `claude setup-token` locally → put via
  //   wrangler secret put CLAUDE_CODE_OAUTH_TOKEN
  // → update /mnt/project/anthropic.md.
  CLAUDE_CODE_OAUTH_TOKEN?: string;

  // codex-bridge (hermes-vps): gpt-5.5 via ChatGPT-Plus OAuth for review reply
  // generation. Primary; DeepSeek is the fallback when the subscription quota
  // is spent. HMAC-signed (X-Bridge-Signature). See SECRETS/openai.md.
  CODEX_BRIDGE_URL?: string;
  CODEX_BRIDGE_HMAC_SECRET?: string;

  // CloudConvert — docx → PDF conversion (Phase PDF)
  // Optional — if missing, PDF endpoint returns 503.
  CLOUDCONVERT_API_KEY?: string;

  // Marketplace API credentials (Phase 6.0 — marketplace integrations)
  // Ozon Seller API (https://api-seller.ozon.ru) — Client-Id + Api-Key headers
  OZON_CLIENT_ID: string;
  OZON_API_KEY: string;
  // Tamara Haar (Customer Support) — preferred names for review/Q&A lane (Owner 2026-07-20)
  // Fallback: OZON_API_KEY / OZON_CLIENT_ID. Never commit values.
  TAMARA_OZON_API_KEY?: string;
  TAMARA_OZON_CLIENT_ID?: string;
  // Ozon discount-request workflow (Tamara morning lane, Owner 2026-07-21):
  // counter grant fraction (default 0.05) and hard cap (default 0.06).
  OZON_DISCOUNT_GRANT?: string;
  OZON_DISCOUNT_CAP?: string;
  OZON_PERF_CLIENT_ID: string;
  OZON_PERF_CLIENT_SECRET: string;

  // Ozon Seller Portal session cookies — for scraping data not exposed in public API
  // (notably "remainingActionStock" — accurate "Осталось продать" per SKU in promo).
  // Must be refreshed manually when session expires. See marketplaces-promos.ts → fetchOzonPortalProducts.
  OZON_PORTAL_COOKIES?: string;

  // Shared secret for VPS scraper to authenticate when POSTing portal data.
  // Generated once at setup, stored in both Worker secrets and VPS .env.
  OZON_PORTAL_INGEST_SECRET?: string;

  // Shared secret for the dasexperten-checkout Worker to authenticate when
  // POSTing website carts (/api/crm/website/cart) and NSS tracking
  // (/api/crm/website/tracking). Set on both Workers via `wrangler secret put`.
  INGEST_SECRET?: string;

  // Feature flag for the in-Worker cookie-based portal scraper. Set to 'true'
  // to re-enable. Disabled by default since 2026-05-18 because TLS-fingerprint
  // mismatch makes session cookies die within days. Analytics-based sold_count
  // is the production source. VPS-ingested portal data (via /ozon/portal-ingest)
  // continues to work regardless of this flag.
  OZON_PORTAL_SCRAPER_ENABLED?: string;
  // Wildberries API (https://*-api.wildberries.ru) — bare token, no Bearer prefix
  WB_API_TOKEN: string;
  WB_API_TOKEN_REVIEWS: string;
  // Tamara Haar — preferred reviews/feedbacks token (Owner 2026-07-20). Fallback: WB_API_TOKEN_REVIEWS.
  TAMARA_WB_API_TOKEN_REVIEWS?: string;

  // Modulbank API (https://api.modulbank.ru/v1) — LK-issued token, Bearer prefix.
  // One token per company; token's first 10 chars also seed webhook signature
  // verification (stored in company_bank_accounts.webhook_signature_prefix).
  MODULBANK_TOKEN_DEE?: string;

  // Retail CRM REST API v5 (https://{shop}.retailcrm.ru/api/v5)
  // shop-domain stored as env, token as secret. Both required for /api/crm/* endpoints.
  RETAIL_CRM_DOMAIN?: string;
  RETAIL_CRM_TOKEN?: string;

  // Yandex KIT API (https://api.kit.yandex.net/v1) — Phase 10.0 loyalty engine.
  // Token issued in KIT cabinet (Настройки → API). See SECRETS/yandex-kit.md.
  YANDEX_KIT_TOKEN?: string;

  // Shared token in the KIT webhook URL (?token=...) — guards
  // POST /api/loyalty/webhook/kit against random hits.
  KIT_WEBHOOK_TOKEN?: string;

  // Yandex Metrika Stat API (https://api-metrika.yandex.net/stat/v1)
  // Counter ID identifies which site's stats to read.
  // Token is OAuth Bearer issued via https://oauth.yandex.ru/authorize
  YANDEX_METRIKA_COUNTER?: string;
  YANDEX_METRIKA_TOKEN?: string;

  // GA4 Data API (analyticsdata.googleapis.com/v1beta) — web analytics
  // command center. GA4_SA_KEY is the full service-account JSON; auth is
  // JWT RS256 via WebCrypto in lib/ga4.ts. Both are Worker secrets.
  GA4_PROPERTY_ID?: string;
  GA4_SA_KEY?: string;

  // Microsoft Clarity Data Export API (scope Data.Export).
  // HARD LIMIT 10 calls/project/day — see lib/clarity.ts quota discipline.
  CLARITY_API_TOKEN?: string;

  // Yandex Direct Reports API v5. NOT SET YET — every consumer degrades to
  // { configured: false } until the token lands (lib/direct.ts).
  DIRECT_OAUTH_TOKEN?: string;

  // F4 Lyubertsy fulfillment / Skladbot WMS — Phase 7.x
  // Bearer token issued 2026-05-13, expires 2026-11-13.
  // See F4_INVENTORY_SECRETS.md for full integration spec.
  F4_SKLADBOT_TOKEN?: string;

  // R2 Bucket — website CRM raw archive (Phase 12.0 — dasexperten.com orders).
  // Bucket das-loyalty-customers, keys under crm/ (orders, customers, imports).
  // Shared with the loyalty-bridge Worker which writes its own top-level keys —
  // everything dasoperator writes stays inside the crm/ prefix.
  CUSTOMERS_DB?: R2Bucket;

  // Stripe (dasexperten.com checkout) — Phase 12.0 website CRM.
  // STRIPE_SECRET_KEY: restricted live key (rk_live_*), see
  //   dasexperten.com repo SECRETS/stripe.md §2. Read access to
  //   PaymentIntents/Refunds is all the poller needs.
  // STRIPE_WEBHOOK_SECRET: whsec_* of the dashboard-created webhook endpoint
  //   /api/crm/website/webhook/stripe. Optional — without it the webhook
  //   answers 503 and the hourly poller carries ingestion alone.
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;

  // Wix REST API — one-shot historical backfill of the .com store
  // (44 orders + 35 members). See dasexperten.com repo SECRETS/wix.md.
  WIX_API_KEY?: string;
  WIX_SITE_ID?: string;
  WIX_ACCOUNT_ID?: string;

  // Telegramer bridge — used by inbox-ingestion-telegram.ts to pull
  // documents (invoices and acceptance certificates) from Telegram chats
  // registered in operation_document_sources with source_type='telegram_contact'.
  // Bearer token shared with telegramer-bridge Worker.
  TELEGRAMER_BRIDGE_SECRET?: string;
}

// =============================================================================
// Unified API response shape (Cloudflare-style)
// =============================================================================
// All endpoints return this structure for consistency with Cloudflare API.

export interface ApiResponse<T = unknown> {
  success: boolean;
  result: T | null;
  errors: ApiError[];
  messages: string[];
}

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

// =============================================================================
// Health check types
// =============================================================================

export interface HealthStatus {
  worker: 'ok';
  bindings: {
    DB: BindingStatus;
    DOCS: BindingStatus;
    PRICELISTS: BindingStatus;
    COUNTERS: BindingStatus;
    FX: BindingStatus;
    CACHE: BindingStatus;
  };
  timestamp: string;
}

export type BindingStatus =
  | { status: 'ok'; latency_ms: number }
  | { status: 'error'; error: string };

