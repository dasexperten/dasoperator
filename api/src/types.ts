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

  // Secrets (Phase 5.x — LLM integration)
  // Set via Cloudflare Workers secrets, never committed to repo.
  DEEPSEEK_API_KEY: string;

  // Gemini API for rating-only review replies (hybrid pipeline)
  GEMINI_API_KEY: string;

  // Qwen (Alibaba DashScope, intl) — rating-only review answers (qwen-max).
  // Set via: wrangler secret put DASHSCOPE_API_KEY
  DASHSCOPE_API_KEY?: string;

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

  // CloudConvert — docx → PDF conversion (Phase PDF)
  // Optional — if missing, PDF endpoint returns 503.
  CLOUDCONVERT_API_KEY?: string;

  // Marketplace API credentials (Phase 6.0 — marketplace integrations)
  // Ozon Seller API (https://api-seller.ozon.ru) — Client-Id + Api-Key headers
  OZON_CLIENT_ID: string;
  OZON_API_KEY: string;
  OZON_PERF_CLIENT_ID: string;
  OZON_PERF_CLIENT_SECRET: string;

  // Ozon Seller Portal session cookies — for scraping data not exposed in public API
  // (notably "remainingActionStock" — accurate "Осталось продать" per SKU in promo).
  // Must be refreshed manually when session expires. See marketplaces-promos.ts → fetchOzonPortalProducts.
  OZON_PORTAL_COOKIES?: string;

  // Shared secret for VPS scraper to authenticate when POSTing portal data.
  // Generated once at setup, stored in both Worker secrets and VPS .env.
  OZON_PORTAL_INGEST_SECRET?: string;

  // Feature flag for the in-Worker cookie-based portal scraper. Set to 'true'
  // to re-enable. Disabled by default since 2026-05-18 because TLS-fingerprint
  // mismatch makes session cookies die within days. Analytics-based sold_count
  // is the production source. VPS-ingested portal data (via /ozon/portal-ingest)
  // continues to work regardless of this flag.
  OZON_PORTAL_SCRAPER_ENABLED?: string;
  // Wildberries API (https://*-api.wildberries.ru) — bare token, no Bearer prefix
  WB_API_TOKEN: string;
  WB_API_TOKEN_REVIEWS: string;

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

  // F4 Lyubertsy fulfillment / Skladbot WMS — Phase 7.x
  // Bearer token issued 2026-05-13, expires 2026-11-13.
  // See F4_INVENTORY_SECRETS.md for full integration spec.
  F4_SKLADBOT_TOKEN?: string;

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

