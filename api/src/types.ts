// =============================================================================
// Cloudflare Worker bindings — must match api/wrangler.toml
// =============================================================================

export interface Env {
  // D1 Database — operational source of truth (Phase 1.1, 1.2)
  DB: D1Database;

  // R2 Bucket — document storage (Phase 1.3)
  // Stores PDFs (CI/PL/contracts), photos, certificates
  DOCS: R2Bucket;

  // R2 Bucket — pricer skill markdown files (Phase 5.1-pricer-r2)
  // Source of truth for product prices. Read by /api/products/:id/price endpoint.
  PRICELISTS: R2Bucket;

  // KV Namespaces (Phase 1.3)
  COUNTERS: KVNamespace;  // sequences cache (DEE-001, CI-202605-0001 etc)
  FX: KVNamespace;        // daily FX rates snapshot
  CACHE: KVNamespace;     // generic ERP cache (hot lookups, sessions)

  // Secrets (Phase 5.x — LLM integration)
  // Set via Cloudflare Workers secrets, never committed to repo.
  DEEPSEEK_API_KEY: string;

  // CloudConvert — docx → PDF conversion (Phase PDF)
  // Optional — if missing, PDF endpoint returns 503.
  CLOUDCONVERT_API_KEY?: string;

  // Marketplace API credentials (Phase 6.0 — marketplace integrations)
  // Ozon Seller API (https://api-seller.ozon.ru) — Client-Id + Api-Key headers
  OZON_CLIENT_ID: string;
  OZON_API_KEY: string;
  OZON_PERF_CLIENT_ID: string;
  OZON_PERF_CLIENT_SECRET: string;
  // Wildberries API (https://*-api.wildberries.ru) — bare token, no Bearer prefix
  WB_API_TOKEN: string;

  // Modulbank API (https://api.modulbank.ru/v1) — LK-issued token, Bearer prefix.
  // One token per company; token's first 10 chars also seed webhook signature
  // verification (stored in company_bank_accounts.webhook_signature_prefix).
  MODULBANK_TOKEN_DEE?: string;

  // Retail CRM REST API v5 (https://{shop}.retailcrm.ru/api/v5)
  // shop-domain stored as env, token as secret. Both required for /api/crm/* endpoints.
  RETAIL_CRM_DOMAIN?: string;
  RETAIL_CRM_TOKEN?: string;
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

