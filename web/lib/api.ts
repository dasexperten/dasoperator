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

// =============================================================================
// Partners
// =============================================================================

export interface Partner {
  id: string;
  trade_name: string;
  legal_name?: string | null;
  country?: string | null;
  tax_id?: string | null;
  iban?: string | null;
  swift_bic?: string | null;
  bank_name?: string | null;
  linked_entity_id?: string | null;
  price_type_id?: string | null;
  currency?: string | null;
  contract_no?: string | null;
  contract_date?: number | null;
  email?: string | null;
  status: 'active' | 'inactive' | 'blocked' | 'pending';
  partner_type: 'buyer' | 'supplier' | 'shipper' | 'other';
  notes?: string | null;
  created_at: number;
  updated_at: number;
}

export interface PartnersListResponse {
  count: number;
  partners: Array<Partner & {
    entity_abbreviation?: string | null;
    price_type_code?: string | null;
  }>;
}

export async function getPartners() {
  return apiGet<PartnersListResponse>('/api/partners');
}

export async function getPartner(slug: string): Promise<ApiResponse<Partner>> {
  const res = await getContact(slug);
  if (!res.success || !res.result) {
    return {
      success: false,
      result: null,
      errors: res.errors,
      messages: res.messages,
    };
  }
  return {
    success: true,
    result: res.result.data as unknown as Partner,
    errors: [],
    messages: res.messages,
  };
}

// =============================================================================
// Contracts (Phase 3.0d-pre)
// =============================================================================

export interface Contract {
  id: string;
  contract_no: string;
  partner_id: string;
  partner_trade_name?: string | null;
  our_company_id: string;
  entity_abbreviation?: string | null;
  currency: string;
  signed_date?: number | null;
  expiry_date?: number | null;
  incoterms?: string | null;
  status: 'draft' | 'active' | 'expired' | 'cancelled';
  notes?: string | null;
  created_at: number;
  updated_at: number;
}

export interface ContractsListResponse {
  count: number;
  contracts: Contract[];
}

export async function getContracts() {
  return apiGet<ContractsListResponse>('/api/contracts');
}

export async function getContract(id: string) {
  return apiGet<Contract>(`/api/contracts/${id}`);
}

export async function getPartnerContracts(slug: string) {
  return apiGet<{ partner_id: string; count: number; contracts: Contract[] }>(
    `/api/partners/${slug}/contracts`
  );
}

export interface CreateContractBody {
  contract_no: string;
  partner_id: string;
  our_company_id: string;
  currency: string;
  signed_date?: number;
  expiry_date?: number;
  incoterms?: string;
  status?: 'draft' | 'active' | 'expired' | 'cancelled';
  notes?: string;
}

export async function createContract(body: CreateContractBody) {
  return apiPost<Contract>('/api/contracts', body);
}
