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
