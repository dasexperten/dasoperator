// =============================================================================
// API client — wraps fetch() to dasoperator-api Worker
// =============================================================================

const API_BASE = 'https://dasoperator-api.dasexperten.workers.dev';

export interface ApiResponse<T = unknown> {
  success: boolean;
  result: T | null;
  errors: Array<{ code: string; message: string; details?: unknown }>;
  messages: string[];
}

export async function apiGet<T = unknown>(path: string): Promise<ApiResponse<T>> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });
  return res.json();
}

export async function apiPost<T = unknown>(
  path: string,
  body: unknown
): Promise<ApiResponse<T>> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

// =============================================================================
// Health
// =============================================================================

// Discriminated union — consumers narrow on `status` to access the right field.
export type HealthBindingStatus =
  | { status: 'ok'; latency_ms: number }
  | { status: 'error'; error: string };

export interface HealthResponse {
  worker: 'ok';
  bindings: {
    DB: HealthBindingStatus;
    DOCS: HealthBindingStatus;
    COUNTERS: HealthBindingStatus;
    FX: HealthBindingStatus;
    CACHE: HealthBindingStatus;
  };
  timestamp: string;
}

export async function getHealth() {
  return apiGet<HealthResponse>('/health');
}

// =============================================================================
// Products
// =============================================================================

export interface Product {
  id: string;
  product_name: string;
  invoice_label: string;
  category: 'Toothpaste' | 'Toothbrush' | 'Floss' | 'Other';
  barcode?: string | null;
  weight_kg?: number | null;
  volume_m3_micro?: number | null;
  manufacturer_id: string;
  manufacturer_name?: string | null;
  manufacturer_country?: string | null;
  notes?: string | null;
}

export interface ProductsLookupResponse {
  count: number;
  products: Product[];
}

export async function getProducts(skuPrefix = 'DE') {
  return apiGet<ProductsLookupResponse>(`/api/products/lookup?sku_prefix=${skuPrefix}`);
}

export async function getProductBySku(sku: string) {
  return apiGet<ProductsLookupResponse>(`/api/products/lookup?sku=${sku}`);
}

// =============================================================================
// Contacts (used for manufacturer detail in product page, etc.)
// =============================================================================

export interface ContactResponse {
  type: 'company' | 'partner' | 'manufacturer' | 'shipper' | 'warehouse';
  data: Record<string, unknown>;
}

export async function getContact(slug: string) {
  return apiGet<ContactResponse>(`/api/contacts/${slug}`);
}
