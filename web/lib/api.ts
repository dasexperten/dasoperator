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

// ---------------------------------------------------------------------------
// Auth header injection — reads token from localStorage on every call so
// login/logout in a sibling tab is reflected immediately. On 401, clears the
// stored token and bounces to /login (browser-only; SSR is a no-op).
// ---------------------------------------------------------------------------

function authHeaders(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    const token = window.localStorage.getItem('dx_auth_token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

function handleAuthFailure(status: number): void {
  if (status !== 401) return;
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem('dx_auth_token');
    window.localStorage.removeItem('dx_auth_user');
    window.localStorage.removeItem('dx_auth_expires');
    // Skip redirect if we're already on the login page
    if (window.location.pathname !== '/login') {
      window.location.href = '/login';
    }
  } catch { /* ignore */ }
}

export async function apiGet<T = unknown>(path: string): Promise<ApiResponse<T>> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
  });
  handleAuthFailure(res.status);
  return res.json();
}

export async function apiPost<T = unknown>(
  path: string,
  body: unknown
): Promise<ApiResponse<T>> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  handleAuthFailure(res.status);
  return res.json();
}

export async function apiPatch<T = unknown>(
  path: string,
  body: unknown
): Promise<ApiResponse<T>> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  handleAuthFailure(res.status);
  return res.json();
}

export async function apiPut<T = unknown>(
  path: string,
  body: unknown
): Promise<ApiResponse<T>> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  handleAuthFailure(res.status);
  return res.json();
}

export async function apiDelete<T = unknown>(
  path: string
): Promise<ApiResponse<T>> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
  });
  handleAuthFailure(res.status);
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
  // Note: /api/products/lookup has a known schema bug (searches non-existent 'sku' column).
  // Until parallel chat fixes it, route through /api/products which returns the full list.
  // The skuPrefix arg is preserved for API compatibility but applied client-side.
  const res = await apiGet<ProductsListPlainResponse>('/api/products');
  if (res.success && res.result) {
    const filtered = skuPrefix
      ? res.result.products.filter((p) => p.id.toLowerCase().startsWith(skuPrefix.toLowerCase()))
      : res.result.products;
    return {
      success: true as const,
      result: { count: filtered.length, products: filtered as unknown as Product[] },
      errors: [],
      messages: [],
    };
  }
  return res as unknown as Awaited<ReturnType<typeof apiGet<ProductsLookupResponse>>>;
}

// Phase 5.1+ — list endpoint replacing /lookup (which has prd_ prefix bug)
export interface ProductListItem {
  id: string;
  product_name: string;
  invoice_label: string;
  category: 'Toothpaste' | 'Toothbrush' | 'Floss' | 'Other';
  manufacturer_id: string;
  manufacturer_name: string | null;
  weight_kg: number | null;
  barcode: string | null;
  pieces_per_case: number;
  hs_code: string | null;
  ctn_qty: number | null;
  country_of_origin: string | null;
  unit_net_weight_g: number | null;
  // Phase 8.1 — marketplace sales coefficient (RU stock / 3mo avg sales)
  monthly_sales: number;
  russia_stock: number;
  coef_dee: number | null;
  signal: 'inactive' | 'dead' | 'out_of_stock' | 'critical' | 'warning' | 'healthy' | 'surplus' | 'severe_surplus';
}

export interface ProductsListPlainResponse {
  count: number;
  products: ProductListItem[];
}

export async function getProductsList(filters?: {
  category?: string;
  manufacturer_id?: string;
  search?: string;
}) {
  const params = new URLSearchParams();
  if (filters?.category) params.set('category', filters.category);
  if (filters?.manufacturer_id) params.set('manufacturer_id', filters.manufacturer_id);
  if (filters?.search) params.set('search', filters.search);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return apiGet<ProductsListPlainResponse>(`/api/products${qs}`);
}

// Phase 5.1+ — single product full row including manufacturer + packaging JOINs
export interface ProductFull {
  id: string;
  product_name: string;
  invoice_label: string;
  category: 'Toothpaste' | 'Toothbrush' | 'Floss' | 'Other';
  subcategory: string | null;
  barcode: string | null;
  weight_kg: number | null;
  volume_m3_micro: number | null;
  manufacturer_id: string;
  buy_price: number | null;
  buy_currency: string | null;
  buy_term: string | null;
  notes: string | null;
  hs_code: string | null;
  ctn_qty: number | null;
  ctn_weight_gross_kg: number | null;
  ctn_dim_l_cm: number | null;
  ctn_dim_w_cm: number | null;
  ctn_dim_h_cm: number | null;
  unit_net_weight_g: number | null;
  country_of_origin: string | null;
  description_ru: string | null;
  description_en: string | null;
  description_cn: string | null;
  invoice_label_ru: string | null;
  invoice_label_en: string | null;
  invoice_label_cn: string | null;
  packaging_manufacturer_id: string | null;
  pieces_per_case: number;
  manufacturer_name: string | null;
  manufacturer_country: string | null;
  manufacturer_city: string | null;
  packaging_manufacturer_name: string | null;
  packaging_manufacturer_country: string | null;
  created_at: number;
  updated_at: number;
}

export async function getProduct(id: string) {
  return apiGet<ProductFull>(`/api/products/${id}`);
}

// Prices
export interface ProductPriceRow {
  id: string;
  price_type_id: string;
  price_type_code: string | null;
  price_type_description: string | null;
  price_type_currency: string | null;
  used_by_entity: string | null;
  sell_price: number;
  currency: string;
  effective_from: number;
  effective_until: number | null;
  notes: string | null;
  is_active: number;
}

export interface ProductPricesResponse {
  count: number;
  prices: ProductPriceRow[];
}

export async function getProductPrices(id: string) {
  return apiGet<ProductPricesResponse>(`/api/products/${id}/prices`);
}

export interface CreateProductPriceBody {
  price_type_id: string;
  sell_price: number;
  effective_from?: number;
  effective_until?: number | null;
  notes?: string | null;
}

export async function createProductPrice(productId: string, body: CreateProductPriceBody) {
  return apiPost<ProductPriceRow>(`/api/products/${productId}/prices`, body);
}

export async function deleteProductPrice(productId: string, priceId: string) {
  const res = await fetch(`${API_BASE}/api/products/${productId}/prices/${priceId}`, {
    method: 'DELETE',
  });
  return res.json() as Promise<ApiResponse<{ id: string; closed_at: number }>>;
}

export interface UpdateProductPriceBody {
  sell_price?: number;
  effective_from?: number;
  effective_until?: number | null;
  notes?: string | null;
}

export async function updateProductPrice(productId: string, priceId: string, body: UpdateProductPriceBody) {
  const res = await fetch(`${API_BASE}/api/products/${productId}/prices/${priceId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<ApiResponse<ProductPriceRow>>;
}

export interface ProductPriceHistoryRow {
  id: string;
  price_type_id: string;
  sell_price: number;
  currency: string;
  effective_from: number;
  effective_until: number | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
  is_active: number;
  is_scheduled: number;
}

export async function getProductPriceHistory(productId: string, priceTypeId: string) {
  return apiGet<{ count: number; history: ProductPriceHistoryRow[] }>(
    `/api/products/${productId}/prices/${priceTypeId}/history`
  );
}


// Bulk pricelist — full SKU→price map for one price type
export interface PricelistResponse {
  price_type_id: string;
  filename: string;
  currency: string;
  last_updated: string;
  prices: Record<string, number>;  // SKU → decimal price
  count: number;
}

export async function getPricelistMap(priceTypeId: string) {
  return apiGet<PricelistResponse>(`/api/pricer/list/${priceTypeId}`);
}

// Activity (recent stock movements for a SKU)
export interface ProductActivityRow {
  id: string;
  type: string;
  warehouse_id: string;
  warehouse_code: string | null;
  warehouse_name: string | null;
  quantity: number;
  balance_after: number;
  source: string;
  source_ref_type: string | null;
  source_ref_id: string | null;
  reason: string | null;
  notes: string | null;
  performed_by: string | null;
  performed_at: number;
  created_at: number;
}

export interface ProductActivityResponse {
  count: number;
  limit: number;
  activity: ProductActivityRow[];
}

export async function getProductActivity(id: string, limit = 20) {
  return apiGet<ProductActivityResponse>(`/api/products/${id}/activity?limit=${limit}`);
}

// Images
export interface ProductImage {
  id: string;
  product_id: string;
  r2_key: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  caption: string | null;
  display_order: number;
  is_primary: boolean;
  uploaded_by: string | null;
  uploaded_at: number;
  created_at: number;
  updated_at: number;
  file_url: string;
}

export interface ProductImagesResponse {
  count: number;
  images: ProductImage[];
}

export async function getProductImages(id: string) {
  return apiGet<ProductImagesResponse>(`/api/products/${id}/images`);
}

export async function uploadProductImage(id: string, file: File) {
  const fd = new FormData();
  fd.set('file', file);
  const res = await fetch(`${API_BASE}/api/products/${id}/images`, {
    method: 'POST',
    body: fd,
  });
  return res.json() as Promise<ApiResponse<ProductImage>>;
}

export interface ParseExcelMatched {
  sku: string;
  qty: number;
  source_row: string;
}

export interface ParseExcelUnmatched {
  text: string;
  reason: string;
}

export interface ParseExcelResponse {
  matched: ParseExcelMatched[];
  unmatched: ParseExcelUnmatched[];
  rows_processed: number;
}

export async function parseOperationExcel(file: File) {
  const fd = new FormData();
  fd.set('file', file);
  const res = await fetch(`${API_BASE}/api/operations/parse-excel`, {
    method: 'POST',
    body: fd,
  });
  return res.json() as Promise<ApiResponse<ParseExcelResponse>>;
}

export async function setPrimaryImage(productId: string, imageId: string) {
  return apiPatch<{ id: string; updated_at: number }>(
    `/api/products/${productId}/images/${imageId}`,
    { is_primary: true }
  );
}

export async function deleteProductImage(productId: string, imageId: string) {
  const res = await fetch(`${API_BASE}/api/products/${productId}/images/${imageId}`, {
    method: 'DELETE',
  });
  return res.json() as Promise<ApiResponse<{ id: string; deleted_at: number }>>;
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


// =============================================================================
// Product create / update
// =============================================================================

export interface CreateProductBody {
  id: string;
  product_name: string;
  invoice_label: string;
  category: 'Toothpaste' | 'Toothbrush' | 'Floss' | 'Other';
  subcategory?: string | null;
  manufacturer_id: string;
  barcode?: string | null;
  pieces_per_case?: number;
  ctn_qty?: number | null;
  ctn_weight_gross_kg?: number | null;
  ctn_dim_l_cm?: number | null;
  ctn_dim_w_cm?: number | null;
  ctn_dim_h_cm?: number | null;
  unit_net_weight_g?: number | null;
  hs_code?: string | null;
  country_of_origin?: string | null;
  weight_kg?: number | null;
  volume_m3_micro?: number | null;
  description_ru?: string | null;
  description_en?: string | null;
  description_cn?: string | null;
  invoice_label_ru?: string | null;
  invoice_label_en?: string | null;
  invoice_label_cn?: string | null;
  packaging_manufacturer_id?: string | null;
  buy_price?: number | null;
  buy_currency?: string | null;
  buy_term?: string | null;
  notes?: string | null;
}

export type UpdateProductBody = Partial<Omit<CreateProductBody, 'id'>>;

export async function createProduct(body: CreateProductBody) {
  return apiPost<Product>('/api/products', body);
}

export async function updateProduct(id: string, body: UpdateProductBody) {
  return apiPut<Product>(`/api/products/${id}`, body);
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
  contact_person?: string | null;
  linked_entity_id?: string | null;
  price_type_id?: string | null;
  currency?: string | null;
  contract_no?: string | null;
  contract_date?: number | null;
  email?: string | null;
  // Legacy DB column with old CHECK constraint — keep for compat
  status: 'active' | 'inactive' | 'blocked' | 'pending';
  // CRM source of truth — Phase 5.x
  crm_status?: 'lead' | 'potential' | 'active' | 'sleeping' | null;
  // Phase 5.x — single source of truth for language of all outbound docs
  partner_language?: 'EN' | 'RU' | 'EN-RU' | 'EN-AR' | 'EN-VI' | 'EN-ZH' | null;
  partner_type: 'buyer' | 'supplier' | 'shipper' | 'other';
  // Phase 8.0 — canonical kind classifier (5 values). Replaces partner_type going forward.
  kind?: 'buyer' | 'manufacturer' | 'service_provider' | 'shipper' | '3pl' | 'other' | null;
  // Phase 9.x — finer subtype within a kind (e.g. service_accounting, service_logistics)
  partner_subtype?: string | null;
  notes?: string | null;
  // Optional extended fields (PATCH-able)
  legal_name_local?: string | null;
  registered_address_local?: string | null;
  inn?: string | null;
  kpp?: string | null;
  ogrn?: string | null;
  payment_terms?: string | null;
  preferred_incoterms?: string | null;
  preferred_invoice_language?: 'EN' | 'RU' | 'BILINGUAL' | null;
  partner_local_language?: 'EN' | 'RU' | 'KA' | 'ZH' | 'VI' | 'AM' | 'UK' | 'DE' | 'TR' | 'UZ' | 'KK' | 'TH' | 'ID' | 'MS' | 'HI' | 'AR' | 'FR' | 'ES' | 'PT' | null;
  last_verified?: number | null;
  // Phase 7.x — 4-letter uppercase code used in contract filenames
  abbreviation?: string | null;
  // Migration 0038 — service-track partners only. When false, invoice doubles
  // as acceptance certificate (subscription model: rent, accounting, banking,
  // telecom). UI checkbox on /partners/:slug/edit, surfaced only for
  // kind='service_provider' partners.
  acceptance_required?: 0 | 1 | null;
  created_at: number;
  updated_at: number;
}

export interface PartnersListResponse {
  count: number;
  partners: Array<Partner & {
    entity_abbreviation?: string | null;
    price_type_code?: string | null;
  }>;
  // Optional — populated only when ?include=balance is passed
  balances?: Array<{
    partner_id: string;
    net_balance_usd: number;
    currencies: Record<string, number>;
  }>;
  fx_date?: string | null;
}

export async function getPartners() {
  return apiGet<PartnersListResponse>('/api/partners');
}

// Combined endpoint — partners list (compact fields) + bulk net-balances
// in a single round-trip. Used by /partners table page.
export async function getPartnersWithBalances() {
  return apiGet<PartnersListResponse>('/api/partners?compact=1&include=balance');
}

// =============================================================================
// Partner CRUD — Phase 5.x
// =============================================================================
export interface CreatePartnerBody {
  trade_name: string;
  kind?: 'buyer' | 'manufacturer' | 'service_provider' | 'shipper' | '3pl' | 'other';
  partner_type?: 'buyer' | 'supplier' | 'shipper' | 'other';
  partner_language?: 'EN' | 'RU' | 'EN-RU' | 'EN-AR' | 'EN-VI' | 'EN-ZH';
  country?: string | null;
  legal_name?: string | null;
  email?: string | null;
  notes?: string | null;
}

export async function createPartner(body: CreatePartnerBody) {
  return apiPost<Partner>('/api/partners', body);
}

export type UpdatePartnerBody = Partial<{
  trade_name: string;
  legal_name: string | null;
  country: string | null;
  email: string | null;
  partner_type: 'buyer' | 'supplier' | 'shipper' | 'other';
  kind: 'buyer' | 'manufacturer' | 'service_provider' | 'shipper' | '3pl' | 'other';
  iban: string | null;
  swift_bic: string | null;
  bank_name: string | null;
  tax_id: string | null;
  inn: string | null;
  kpp: string | null;
  ogrn: string | null;
  legal_name_local: string | null;
  registered_address_local: string | null;
  preferred_incoterms: string | null;
  preferred_invoice_language: 'EN' | 'RU' | 'BILINGUAL' | null;
  partner_local_language: 'EN' | 'RU' | 'KA' | 'ZH' | 'VI' | 'AM' | 'UK' | 'DE' | 'TR' | 'UZ' | 'KK' | 'TH' | 'ID' | 'MS' | 'HI' | 'AR' | 'FR' | 'ES' | 'PT' | null;
  payment_terms: string | null;
  linked_entity_id: string | null;
  price_type_id: string | null;
  currency: string | null;
  notes: string | null;
  abbreviation: string | null;
  acceptance_required: boolean;
}>;

export async function updatePartner(slug: string, body: UpdatePartnerBody) {
  return apiPatch<{ id: string; updated_at: number; fields_updated: number }>(
    `/api/partners/${slug}`, body
  );
}

// Partner agreements (NDA / MOU / LOI / Contract) — drives CRM promotion lead → potential
export interface PartnerAgreement {
  id: string;
  agreement_type: 'nda' | 'mou' | 'loi' | 'contract' | 'amendment' | 'other';
  title?: string | null;
  signed_date?: number | null;
  expiry_date?: number | null;
  file_r2_key?: string | null;
  status: 'draft' | 'signed' | 'expired' | 'cancelled';
  notes?: string | null;
  created_at: number;
  updated_at: number;
}

export async function getPartnerAgreements(slug: string) {
  return apiGet<{ partner_id: string; count: number; agreements: PartnerAgreement[] }>(
    `/api/partners/${slug}/agreements`
  );
}

export interface CreateAgreementBody {
  agreement_type: 'nda' | 'mou' | 'loi' | 'contract' | 'amendment' | 'other';
  title?: string | null;
  signed_date?: number | null;
  expiry_date?: number | null;
  file_r2_key?: string | null;
  status?: 'draft' | 'signed' | 'expired' | 'cancelled';
  notes?: string | null;
}

export async function createPartnerAgreement(slug: string, body: CreateAgreementBody) {
  return apiPost<{
    id: string;
    partner_id: string;
    agreement_type: string;
    status: string;
    crm_promoted: boolean;
    new_crm_status: string;
  }>(`/api/partners/${slug}/agreements`, body);
}

// Generate NDA via DeepSeek PRO + render to DOCX + upload to R2
export interface GenerateNdaResult {
  agreement_id: string;
  partner_id: string;
  file_r2_key: string;
  download_url: string;
  status: string;
  tokens_used: { in: number; out: number };
}

export async function generatePartnerNda(slug: string) {
  return apiPost<GenerateNdaResult>(`/api/partners/${slug}/agreements/generate-nda`, {});
}

// Build absolute download URL for an agreement file
export function agreementDownloadUrl(slug: string, agreementId: string): string {
  return `${API_BASE}/api/partners/${slug}/agreements/${agreementId}/download`;
}

// Internal entities (DEE/DEI/DEASEAN/DEC) — used in Transfer + Purchase (DEI as seller)
export interface Company {
  id: string;
  abbreviation: string | null;
  legal_name: string;
  jurisdiction: string | null;
}
export interface CompaniesResponse {
  count: number;
  companies: Company[];
}
export async function getCompanies() {
  return apiGet<CompaniesResponse>('/api/companies');
}

// Factory manufacturers — used in Purchase as primary seller list
export interface Manufacturer {
  id: string;
  name: string;
  country: string | null;
}
export interface ManufacturersResponse {
  count: number;
  manufacturers: Manufacturer[];
}
export async function getManufacturers() {
  return apiGet<ManufacturersResponse>('/api/manufacturers');
}

// Products this factory can produce (via product_manufacturers M:N).
// Used by Purchase form to filter SKU dropdown.
export async function getProductsByManufacturer(manufacturerId: string) {
  return apiGet<{ count: number; products: Product[] }>(`/api/manufacturers/${manufacturerId}/products`);
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
  vat_rate: 0 | 5 | 20;
  agreement_type?: 'main' | 'addendum' | 'annex' | 'sla' | 'nda' | 'mou' | 'loi' | 'other' | null;
  parent_contract_id?: string | null;
  addendum_no?: string | null;
  contract_file_key?: string | null;
  // Russian currency-control fields (УНК / ВБК) — applicable to DEE foreign contracts
  unk_reference?: string | null;
  unk_valid_until?: number | null;
  created_at: number;
  updated_at: number;
}

export interface ContractsListResponse {
  count: number;
  contracts: Array<Contract & {
    partner_abbreviation?: string | null;
  }>;
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

export type AgreementType =
  | 'main' | 'addendum' | 'annex' | 'sla'
  | 'nda' | 'mou' | 'loi' | 'other';

export interface CreateContractBody {
  contract_no?: string;  // optional for legal docs (nda/mou/loi/other)
  partner_id: string;
  our_company_id?: string;  // optional for legal docs
  currency?: string;  // optional for legal docs
  agreement_type?: AgreementType;
  signed_date?: number;
  expiry_date?: number;
  incoterms?: string;
  status?: 'draft' | 'active' | 'expired' | 'cancelled';
  notes?: string;
  vat_rate?: 0 | 5 | 20;
  // Russian currency-control fields (УНК / ВБК) — for DEE foreign contracts
  unk_reference?: string;
  unk_valid_until?: number;
}

export async function createContract(body: CreateContractBody) {
  return apiPost<Contract>('/api/contracts', body);
}

// PATCH /api/contracts/:id — edit existing contract.
// Only supplied fields are touched. partner_id is intentionally NOT editable.
export interface PatchContractBody {
  contract_no?: string;
  agreement_type?: AgreementType;
  signed_date?: number | null;
  expiry_date?: number | null;
  status?: 'draft' | 'active' | 'expired' | 'cancelled';
  notes?: string | null;
  currency?: string;
  our_company_id?: string;
  incoterms?: string | null;
  vat_rate?: 0 | 5 | 20;
  unk_reference?: string | null;
  unk_valid_until?: number | null;
}

export async function patchContract(id: string, body: PatchContractBody) {
  const res = await fetch(`${API_BASE}/api/contracts/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok || !(json as { success?: boolean }).success) {
    throw new Error(
      ((json as { errors?: Array<{ message?: string }> }).errors?.[0]?.message) ||
      `PATCH /api/contracts/${id} failed (${res.status})`
    );
  }
  return (json as { result: { id: string; fields_updated: string[]; crm_promoted: boolean; updated_at: number } }).result;
}

// Contract file (PDF in R2) — Phase 7.1
export function getContractFileUrl(id: string): string {
  return `${API_BASE}/api/contracts/${id}/file`;
}

export async function uploadContractFile(
  id: string,
  file: File
): Promise<ApiResponse<{ contract_id: string; contract_file_key: string; size_bytes: number; uploaded_at: number }>> {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch(`${API_BASE}/api/contracts/${id}/file`, {
    method: 'POST',
    body: fd,
  });
  return res.json();
}

export async function deleteContractFile(
  id: string
): Promise<ApiResponse<{ contract_id: string }>> {
  const res = await fetch(`${API_BASE}/api/contracts/${id}/file`, {
    method: 'DELETE',
  });
  return res.json();
}

// =============================================================================
// Payments (Phase 3.0e)
// =============================================================================

export interface Payment {
  id: string;
  partner_id: string;
  partner_trade_name?: string | null;
  contract_id: string;
  contract_no?: string | null;
  contract_currency?: string | null;
  operation_id: string | null;
  amount: number;
  currency: string;
  payment_date: number;
  type: 'advance' | 'final' | 'refund' | 'partial';
  direction: 'incoming' | 'outgoing';
  notes?: string | null;
  created_at: number;
  updated_at: number;
}

export interface PaymentsListResponse {
  count: number;
  payments: Payment[];
}

export async function getPayments(filters?: {
  partner_id?: string;
  contract_id?: string;
  operation_id?: string;
}) {
  const params = new URLSearchParams();
  if (filters?.partner_id) params.set('partner_id', filters.partner_id);
  if (filters?.contract_id) params.set('contract_id', filters.contract_id);
  if (filters?.operation_id) params.set('operation_id', filters.operation_id);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return apiGet<PaymentsListResponse>(`/api/payments${qs}`);
}

/** Home dashboard — dasexperten.com Ubersuggest snapshot (KV-cached on API). */
export interface SiteSeoMetrics {
  domain: string;
  domain_authority: number;
  backlinks: number;
  ref_domains: number;
  organic_traffic: number;
  updated_at: number;
  source: string;
}

export async function getSiteSeoMetrics(domain = 'dasexperten.com') {
  return apiGet<SiteSeoMetrics>(`/api/seo/site-metrics?domain=${encodeURIComponent(domain)}`);
}

/** AI crawlers snapshot — Cloudflare UA pull stored in KV (demo=false when live). */
export interface AiCrawlerTile {
  operator: string;
  bot: string;
  extraBots: number;
  allowed: string;
  allowed_n: number;
  referrals: number;
  bytes?: number;
}

export interface AiCrawlersSnapshot {
  domain: string;
  window_days: number;
  window_start: string;
  window_end: string;
  total_requests: number;
  total_with_search_bots?: number;
  allowed: number;
  allowed_pct: number;
  unsuccessful: number;
  referrals: number;
  source: string;
  demo: boolean;
  updated_at: number;
  note?: string;
  crawlers: AiCrawlerTile[];
  spark: number[];
}

export async function getAiCrawlers(domain = 'dasexperten.com') {
  return apiGet<AiCrawlersSnapshot>(`/api/seo/ai-crawlers?domain=${encodeURIComponent(domain)}`);
}

export async function getPayment(id: string) {
  return apiGet<Payment>(`/api/payments/${id}`);
}

export interface CreatePaymentBody {
  partner_id: string;
  contract_id: string;
  operation_id?: string | null;
  amount: number;
  currency: string;
  payment_date: number;
  type: 'advance' | 'final' | 'refund' | 'partial';
  direction: 'incoming' | 'outgoing';
  notes?: string;
}

export async function createPayment(body: CreatePaymentBody) {
  return apiPost<Payment>('/api/payments', body);
}

// =============================================================================
// Net Balance (Phase 3.0e — USD pivot)
// =============================================================================

export interface NetBalanceBreakdown {
  currency: string;
  balance: number;
  balance_usd: number;
}

export interface PartnerNetBalance {
  partner_id: string;
  currencies_breakdown: NetBalanceBreakdown[];
  net_balance_usd: number;
  fx_date: string | null;
  calculated_at: number;
}

export async function getPartnerNetBalance(slug: string) {
  return apiGet<PartnerNetBalance>(`/api/partners/${slug}/net-balance`);
}
export interface PartnerBankAccount {
  id: string;
  partner_id: string;
  account_label: string;
  bank_name: string;
  bank_address?: string | null;
  account_number: string;
  swift_bic?: string | null;
  iban?: string | null;
  cnaps_code?: string | null;
  bik_code?: string | null;
  currency?: string | null;
  correspondent_bank_name?: string | null;
  correspondent_swift?: string | null;
  is_default: number;
  routing_buyer_entities?: string | null;
  notes?: string | null;
  created_at: number;
  updated_at: number;
}

export async function getPartnerBankAccounts(slug: string) {
  return apiGet<{ count: number; accounts: PartnerBankAccount[] }>(
    `/api/partners/${slug}/bank-accounts`
  );
}
export interface SupplierRouteResolution {
  issuing_partner_id: string;
  bank_account: PartnerBankAccount | null;
  reasoning: string;
  route_type: 'direct_dee' | 'via_intermediary';
}

export async function resolveSupplierRoute(params: {
  manufacturer_id: string;
  our_company_id: string;
  via_dei?: boolean;
}) {
  const qs = new URLSearchParams({
    manufacturer_id: params.manufacturer_id,
    our_company_id: params.our_company_id,
    via_dei: params.via_dei ? '1' : '0',
  });
  return apiGet<SupplierRouteResolution>(`/api/partners/resolve-supplier-route?${qs.toString()}`);
}



export interface BulkNetBalances {
  count: number;
  balances: Array<{
    partner_id: string;
    net_balance_usd: number;
    currencies: Record<string, number>;
  }>;
  fx_date: string | null;
}

export async function getAllNetBalances() {
  return apiGet<BulkNetBalances>('/api/net-balance');
}

// =============================================================================
// FX rates
// =============================================================================

export interface FxLatest {
  date: string;
  source: string;
  fetched_at: number;
  rates: Record<string, { rate_to_usd_nano: number }>;
}

export async function getFxLatest() {
  return apiGet<FxLatest>('/api/fx/latest');
}

// =============================================================================
// Product price for contract context (Phase 3.0e — auto-fill)
// =============================================================================

export interface ProductPriceForContract {
  price: number | null;
  currency: string;
  source: 'price_list' | 'not_found' | 'no_price_type';
  price_type_id?: string;
  effective_from?: number;
  effective_until?: number | null;
}

export async function getProductPriceForContract(productId: string, contractId: string) {
  return apiGet<ProductPriceForContract>(
    `/api/products/${productId}/price?contract_id=${contractId}`
  );
}

// =============================================================================
// Operations (Phase 3.0e — contract_id-based create)
// =============================================================================

export interface Operation {
  id: string;
  contract_id: string | null;
  contract_no?: string | null;
  partner_id: string | null;
  partner_trade_name?: string | null;
  our_company_id: string;
  entity_abbreviation?: string | null;
  operation_type: 'sale' | 'purchase' | 'transfer' | 'service' | 'tax';
  operation_track?: 'goods' | 'service';
  partner_kind?: string | null;
  // Phase 0039 — transfer batches
  is_batch?: boolean;
  cluster_count?: number;
  marketplace?: 'OZN' | 'WB';
  batch_accepted?: boolean;
  total_units?: number;
  arrival_detected_at?: number | null;
  arrival_received_qtys?: string | null;
  arrival_rejected_at?: number | null;
  arrival_source_request_id?: string | null;
  arrival_request_completed?: number | null;
  arrival_delivery_number?: string | null;
  gtd_number?: string | null;
  operation_date: number;
  warehouse_from_id: string | null;
  warehouse_to_id: string | null;
  manufacturer_id: string | null;
  manufacturer_name?: string | null;
  currency: string;
  fx_rate_to_usd: number | null;
  total_amount: number;
  total_usd_equiv: number | null;
  status: string;
  reference: string | null;
  order_doc_ref: string | null;
  notes: string | null;
  incoterms: string | null;
  vat_rate: 0 | 5 | 20;
  paid_amount?: number;
  payment_state?: 'neutral' | 'unpaid' | 'partial' | 'paid';
  delivery_status?: 'pending' | 'delivered' | 'disputed' | 'refunded';
  // Banking route snapshot (set at create time for purchase ops via auto-resolver)
  issuing_partner_id?: string | null;
  issuing_partner_name?: string | null;
  issuing_bank_account_id?: string | null;
  issuing_bank_label?: string | null;
  issuing_bank_name?: string | null;
  issuing_account_number?: string | null;
  issuing_bank_swift?: string | null;
  issuing_bank_cnaps?: string | null;
  issuing_bank_iban?: string | null;
  issuing_bank_currency?: string | null;
  issuing_bank_address?: string | null;
  issuing_correspondent_bank?: string | null;
  issuing_correspondent_swift?: string | null;
  // Pass-through routing info
  dei_layer?: number | null;
  created_at: number;
  updated_at: number;
  // Service-track signals (set by GET /api/operations/:id when operation_track='service')
  has_acceptance_attachment?: boolean;
  has_invoice_attachment?: boolean;
  partner_acceptance_required?: 0 | 1 | null;
}

export interface OperationLineItem {
  id: string;
  operation_id: string;
  product_id: string;
  product_name?: string | null;
  invoice_label?: string | null;
  item_description: string | null;
  qty: number;
  cartons: number;
  inner_boxes: number;
  unit_price: number;
  discount_pct: number;
  unit_price_after_disc: number;
  line_amount: number;
  currency: string;
  line_usd_equiv: number | null;
}

export async function getOperation(id: string) {
  return apiGet<{ operation: Operation; line_items: OperationLineItem[] }>(
    `/api/operations/${id}`
  );
}

export interface OperationsListResponse {
  count: number;
  operations: Operation[];
}

export async function getOperations(filters?: {
  partner_id?: string;
  contract_id?: string;
  operation_type?: string;
  status?: string;
  include_cancelled?: boolean;
  // ?compact=1 — slim payload, only fields used by list/table views.
  // Cuts response from ~277 KB to ~50 KB on 335 operations.
  compact?: boolean;
}) {
  const params = new URLSearchParams();
  if (filters?.partner_id) params.set('partner_id', filters.partner_id);
  if (filters?.contract_id) params.set('contract_id', filters.contract_id);
  if (filters?.operation_type) params.set('operation_type', filters.operation_type);
  if (filters?.status) params.set('status', filters.status);
  if (filters?.include_cancelled) params.set('include_cancelled', '1');
  if (filters?.compact) params.set('compact', '1');
  const qs = params.toString() ? `?${params.toString()}` : '';
  return apiGet<OperationsListResponse>(`/api/operations${qs}`);
}

export interface CreateOperationLineItem {
  product_id: string;
  qty: number;
  unit_price: number;
  discount_pct?: number;
  cartons?: number;
  inner_boxes?: number;
  item_description?: string;
}

export interface CreateOperationBody {
  // SALE: contract_id required (carries partner+company+currency).
  // PURCHASE / TRANSFER: contract_id omitted, fields below provided directly.
  contract_id?: string;
  operation_type: 'sale' | 'purchase' | 'transfer' | 'service' | 'tax';
  operation_date: number;
  warehouse_from_id?: string;
  warehouse_to_id?: string;
  // PURCHASE: factory we buy from
  manufacturer_id?: string;
  // PURCHASE / TRANSFER: our buying / sending entity
  our_company_id?: string;
  // TRANSFER: recipient entity
  receiving_company_id?: string;
  // PURCHASE / TRANSFER: ISO-4217 currency (CNY/USD/EUR/RUB/...)
  currency?: string;
  // PURCHASE: 1 = Through DEI passthrough (DEE/DASEAN/DEC buyers only)
  dei_layer?: 0 | 1;
  price_type_id?: string;
  incoterms?: string;
  notes?: string;
  order_doc_ref?: string;
  // Phase 9.x — service operations distinguish 'service' from default 'goods'
  operation_track?: 'goods' | 'service';
  partner_id?: string;
  service_description?: string;
  service_category_id?: string;
  service_amount?: number;
  gtd_number?: string;
  line_items: CreateOperationLineItem[];
}

export async function createOperation(body: CreateOperationBody) {
  return apiPost<{ operation: Operation; line_items: OperationLineItem[]; warnings: string[] }>(
    '/api/operations',
    body
  );
}

export type OperationStatusTarget =
  | 'issued'
  | 'production'
  | 'order_fulfilment'
  | 'shipped'
  | 'delivered'
  | 'cancelled';

export interface UpdateStatusResponse {
  id: string;
  previous_status: string;
  status: OperationStatusTarget;
  updated_at: number;
}

export async function updateOperationStatus(
  id: string,
  status: OperationStatusTarget
) {
  return apiPatch<UpdateStatusResponse>(`/api/operations/${id}/status`, { status });
}

export interface DeleteOperationResponse {
  id: string;
  reference: string | null;
  deleted: true;
}

export async function deleteOperation(id: string) {
  return apiDelete<DeleteOperationResponse>(`/api/operations/${id}`);
}
// =============================================================================
// Line items — edit composition of an existing operation
// =============================================================================

export async function updateLineItem(
  id: string,
  body: { qty?: number; unit_price?: number }
) {
  return apiPatch<{ id: string; operation_id: string; docs_cancelled: boolean; updated_at: number }>(
    `/api/operations/api/line-items/${id}`,
    body
  );
}

export async function addLineItem(
  operationId: string,
  body: {
    product_id: string;
    qty: number;
    unit_price: number;
    discount_pct?: number;
    cartons?: number;
    inner_boxes?: number;
    item_description?: string | null;
  }
) {
  return apiPost<{ id: string; operation_id: string; docs_cancelled: boolean }>(
    `/api/operations/${operationId}/line-items`,
    body
  );
}

export async function deleteLineItem(id: string) {
  return apiDelete<{ id: string; operation_id: string; docs_cancelled: boolean }>(
    `/api/operations/api/line-items/${id}`
  );
}



// =============================================================================
// Inventory — Phase 4.4 frontend wiring
// =============================================================================

export interface Warehouse {
  id: string;
  code: string;
  name: string;
  country?: string | null;
  city?: string | null;
  warehouse_type?: string | null;
  owner_id?: string | null;
  owner_company_id?: string | null;
  owner_manufacturer_id?: string | null;
  owner_partner_id?: string | null;
  external_provider?: string | null;
  external_customer_id?: string | null;
  external_sync_at?: number | null;
  notes?: string | null;
  created_at: number;
  updated_at: number;
}

export interface WarehousesListResponse {
  count: number;
  warehouses: Warehouse[];
}

export async function getWarehouses(filters?: {
  company_id?: string;
  manufacturer_id?: string;
  partner_id?: string;
  ownership?: 'owner_only';
}) {
  const params = new URLSearchParams();
  if (filters?.company_id) params.set('company_id', filters.company_id);
  if (filters?.manufacturer_id) params.set('manufacturer_id', filters.manufacturer_id);
  if (filters?.partner_id) params.set('partner_id', filters.partner_id);
  if (filters?.ownership) params.set('ownership', filters.ownership);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return apiGet<WarehousesListResponse>(`/api/warehouses${qs}`);
}

export interface WarehouseDetail extends Warehouse {
  last_counted_at: number | null;
  last_movement_at: number | null;
}

export async function getWarehouse(id: string) {
  return apiGet<WarehouseDetail>(`/api/warehouses/${id}`);
}

// -----------------------------------------------------------------------------
// Bundling suggestions — inferred packing/unpacking activity from stock movements
// -----------------------------------------------------------------------------

export interface BundlingSuggestionLeg {
  product_id: string;
  product_name: string;
  bundle_size: number;
  delta: number;
  sources: string;
}

export interface BundlingSuggestion {
  warehouse_id: string;
  family_base: string;
  day: string;
  direction: 'pack' | 'unpack';
  single: BundlingSuggestionLeg;
  bundle: BundlingSuggestionLeg;
  single_units: number;
  bundle_units_in_singles: number;
  variance_units: number;
  variance_pct: number;
  ts_diff_seconds: number;
  confidence: 'high' | 'medium' | 'low';
}

export interface BundlingSuggestionsResponse {
  warehouse_id: string;
  days: number;
  suggestions: BundlingSuggestion[];
}

export async function getBundlingSuggestions(warehouseId: string, days = 30) {
  return apiGet<BundlingSuggestionsResponse>(
    `/api/warehouses/${warehouseId}/bundling-suggestions?days=${days}`
  );
}

// -----------------------------------------------------------------------------
// Products with stock breakdown
// -----------------------------------------------------------------------------

export interface ProductWarehouseStock {
  warehouse_id: string;
  code: string;
  name: string;
  on_hand: number;
  in_production?: number;  // factory reservation, rendered as "+N" green suffix
}

export interface ProductWithStock {
  id: string;
  product_name: string;
  invoice_label: string;
  manufacturer_id: string | null;
  pieces_per_case: number;
  total_on_hand: number;
  marketplace_ozon: number;
  marketplace_wb: number;
  on_the_way?: number;  // OTW (otw) — sum across all in-transit
  warehouses: ProductWarehouseStock[];
}

export interface ProductsWithStockResponse {
  count: number;
  products: ProductWithStock[];
}

export async function getProductsWithStock() {
  return apiGet<ProductsWithStockResponse>('/api/products/with-stock');
}

// -----------------------------------------------------------------------------
// Stocks (existing API surface, typed wrappers)
// -----------------------------------------------------------------------------

export interface StockRow {
  id: string;
  warehouse_id: string;
  code: string;
  name: string;
  product_id: string;
  product_name: string;
  invoice_label: string;
  pieces_per_case: number;
  on_hand: number;
  last_movement_at: number | null;
  last_counted_at: number | null;
  last_counted_by: string | null;
  updated_at: number;
}

export interface StocksListResponse {
  count: number;
  stocks: StockRow[];
}

export async function getStocks(filters?: { warehouse_id?: string; product_id?: string }) {
  const params = new URLSearchParams();
  if (filters?.warehouse_id) params.set('warehouse_id', filters.warehouse_id);
  if (filters?.product_id) params.set('product_id', filters.product_id);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return apiGet<StocksListResponse>(`/api/stocks${qs}`);
}

// -----------------------------------------------------------------------------
// Stock transfer — move stock between two warehouses of the same company
// -----------------------------------------------------------------------------

export interface StockTransferLine {
  product_id: string;
  quantity: number;
}

export interface StockTransferParams {
  from_warehouse_id: string;
  to_warehouse_id: string;
  lines: StockTransferLine[];
  reason?: string | null;
  notes?: string | null;
  performed_by?: string | null;
}

export interface StockTransferResult {
  transfer_ref: string;
  from_warehouse: { id: string; code: string };
  to_warehouse: { id: string; code: string };
  company_id: string;
  lines: Array<{
    product_id: string;
    product_name: string;
    quantity: number;
    from_balance_after: number;
    to_balance_after: number;
  }>;
}

export async function transferStock(params: StockTransferParams) {
  return apiPost<StockTransferResult>('/api/stocks/transfer', params);
}

export interface ProductStockResponse {
  product: { id: string; product_name: string; pieces_per_case: number };
  total_on_hand: number;
  by_warehouse: Array<{
    warehouse_id: string;
    code: string;
    name: string;
    on_hand: number;
    last_movement_at: number | null;
    last_counted_at: number | null;
  }>;
}

export async function getProductStock(productId: string) {
  return apiGet<ProductStockResponse>(`/api/products/${productId}/stock`);
}

// -----------------------------------------------------------------------------
// Stock movements
// -----------------------------------------------------------------------------

export type MovementType =
  | 'receipt' | 'shipment' | 'transfer_in' | 'transfer_out'
  | 'adjustment' | 'session_correction' | 'sync_correction'
  | 'opening_balance' | 'write_off' | 'return';

export type MovementSource =
  | 'manual' | 'operation' | 'session'
  | 'sync_wb' | 'sync_ozon' | 'sync_3pl' | 'sync_api'
  | 'cron' | 'opening';

export interface StockMovement {
  id: string;
  warehouse_id: string;
  code: string;
  product_id: string;
  product_name: string;
  invoice_label: string;
  movement_type: MovementType;
  quantity: number;
  balance_after: number;
  source: MovementSource;
  source_ref_type: string | null;
  source_ref_id: string | null;
  reason: string | null;
  notes: string | null;
  performed_by: string | null;
  performed_at: number;
  created_at: number;
}

export interface StockMovementsListResponse {
  count: number;
  limit: number;
  movements: StockMovement[];
}

export async function getStockMovements(filters?: {
  warehouse_id?: string;
  product_id?: string;
  movement_type?: MovementType;
  source?: MovementSource;
  source_ref_id?: string;
  date_from?: number;
  date_to?: number;
  limit?: number;
}) {
  const params = new URLSearchParams();
  if (filters?.warehouse_id) params.set('warehouse_id', filters.warehouse_id);
  if (filters?.product_id) params.set('product_id', filters.product_id);
  if (filters?.movement_type) params.set('movement_type', filters.movement_type);
  if (filters?.source) params.set('source', filters.source);
  if (filters?.source_ref_id) params.set('source_ref_id', filters.source_ref_id);
  if (filters?.date_from) params.set('date_from', String(filters.date_from));
  if (filters?.date_to) params.set('date_to', String(filters.date_to));
  if (filters?.limit) params.set('limit', String(filters.limit));
  const qs = params.toString() ? `?${params.toString()}` : '';
  return apiGet<StockMovementsListResponse>(`/api/stock-movements${qs}`);
}

// -----------------------------------------------------------------------------
// Inventory sessions
// -----------------------------------------------------------------------------

export type SessionStatus = 'open' | 'counting' | 'committed' | 'cancelled';

export interface InventorySession {
  id: string;
  reference: string;
  warehouse_id: string;
  code: string;
  name: string;
  status: SessionStatus;
  scope: 'full' | 'partial' | 'spot';
  started_at: number;
  started_by: string | null;
  committed_at: number | null;
  committed_by: string | null;
  cancelled_at: number | null;
  cancelled_by: string | null;
  notes: string | null;
  total_lines: number;
  total_discrepancies: number;
  created_at: number;
  updated_at: number;
}

export interface InventorySessionsListResponse {
  count: number;
  sessions: InventorySession[];
}

export async function getInventorySessions(filters?: { warehouse_id?: string; status?: SessionStatus }) {
  const params = new URLSearchParams();
  if (filters?.warehouse_id) params.set('warehouse_id', filters.warehouse_id);
  if (filters?.status) params.set('status', filters.status);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return apiGet<InventorySessionsListResponse>(`/api/inventory-sessions${qs}`);
}


// =============================================================================
// Marketplace stocks (Phase 6.0)
// =============================================================================
// Aggregated marketplace stock per canonical SKU. Multipack listings
// (DE201AA = 2 pcs, DE201AAAA = 4 pcs) are already multiplied server-side.

export interface MarketplaceStockRow {
  base_sku: string;
  ozon_units: number;
  wb_units: number;
  ozon_synced_at: number | null;
  wb_synced_at: number | null;
}

export interface MarketplaceStocksResponse {
  stocks: MarketplaceStockRow[];
}

export async function getMarketplaceStocks() {
  return apiGet<MarketplaceStocksResponse>('/api/marketplaces/stocks');
}

// =============================================================================
// External warehouse stocks (Phase 7.x — F4 Lyubertsy via Skladbot WMS)
// =============================================================================
// The same physical warehouse (lbr) is operated by an external fulfillment
// partner. Their numbers come from an external WMS API. We store the snapshot
// in external_stocks and show it in brackets next to our internal number on
// the warehouses page.

export interface ExternalStockByProductRow {
  product_id: string | null;
  warehouse_id: string;
  external_vendor_code: string;
  amount: number;
  reserve_amount: number;
  repair_amount: number;
  synced_at: number;
}

export interface ExternalStocksByProductResponse {
  rows: ExternalStockByProductRow[];
}

export async function getExternalStocksByProduct() {
  return apiGet<ExternalStocksByProductResponse>('/api/external-stocks/by-product');
}

export async function syncExternalStocks(warehouseId?: string) {
  return apiPost<{ synced: Array<{ warehouse_id: string; rows: number; provider: string }> }>(
    '/api/external-stocks/sync',
    warehouseId ? { warehouse_id: warehouseId } : {}
  );
}


// =============================================================================
// External warehouse requests (F4 Skladbot заявки) — Phase 7.x
// =============================================================================
export interface ExternalRequestRow {
  id: string;
  external_id: number;
  delivery_number: string;
  warehouse_id: string;
  request_type_raw: string;
  request_type_norm: 'acceptance' | 'mp_delivery' | 'writeoff' | 'pickup_acceptance' | 'other';
  stage_code: string | null;
  stage_name: string | null;
  is_completed: number;
  is_archived: number;
  is_expired: number;
  created_at_external: string | null;
  executor: string | null;
  creator: string | null;
  comment: string | null;
  imported_op_id: string | null;
  synced_at: number;
  item_count: number;
  total_amount: number | null;
  destinations: string | null;
}

export interface ExternalRequestItem {
  id: string;
  external_request_id: string;
  external_item_id: number | null;
  vendor_code: string;
  product_id: string | null;
  product_name: string | null;
  barcode: string | null;
  amount: number;
  accepted_amount: number;
  delivery_amount: number;
  repair_amount: number;
  recycle_amount: number;
  comment: string | null;
  bundling_divisor: number | null;
  bundling_from_qty: number | null;
  bundling_to_qty: number | null;
  created_at: number;
}

export async function getExternalRequests(filters: {
  warehouse_id?: string;
  type_norm?: string;
  completed?: '0' | '1';
  archived?: '0' | '1';
}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v !== undefined) qs.set(k, v);
  return apiGet<{ requests: ExternalRequestRow[] }>(`/api/external-requests?${qs.toString()}`);
}

export async function getExternalRequest(id: string) {
  return apiGet<{ request: ExternalRequestRow; items: ExternalRequestItem[] }>(
    `/api/external-requests/${encodeURIComponent(id)}`
  );
}

export async function syncExternalRequests() {
  return apiPost<{ synced: number; total: number; errors: string[] }>(
    '/api/external-requests/sync',
    {}
  );
}




// =============================================================================
// Marketplace sync health + log (Phase 6.0b)
// =============================================================================

// /api/marketplaces/health — last sync per marketplace (provided by parallel chat)
export interface MarketplaceSyncEntry {
  marketplace: 'ozon' | 'wb';
  started_at: number;
  finished_at: number | null;
  status: 'running' | 'ok' | 'error';
  rows_synced: number | null;
  error_message: string | null;
}

export interface MarketplaceHealthResponse {
  ozon: MarketplaceSyncEntry | null;
  wb: MarketplaceSyncEntry | null;
}

export async function getMarketplaceHealth() {
  return apiGet<MarketplaceHealthResponse>('/api/marketplaces/health');
}

// /api/marketplaces/sync/log — last N attempts (this chat's extras endpoint)
export interface MarketplaceSyncLogEntry extends MarketplaceSyncEntry {
  id: number;
}

export interface MarketplaceSyncLogResponse {
  count: number;
  log: MarketplaceSyncLogEntry[];
}

export async function getMarketplaceSyncLog(limit = 20) {
  return apiGet<MarketplaceSyncLogResponse>(`/api/marketplaces/sync/log?limit=${limit}`);
}


// =============================================================================
// Marketplace sales (Phase 6.2 — funnel + position + price + ad spend)
// =============================================================================

export interface MarketplaceSalesTotal {
  units_sold: number;
  revenue_rub: number;
  synced_at: number | null;
}

export interface MarketplaceSalesDailyRow {
  marketplace: 'ozon' | 'wb';
  date: string;
  units_sold: number;
  revenue_rub: number;
}

export interface MarketplaceSalesTopRow {
  sku: string;
  product_name: string;
  units_sold: number;
  revenue_rub: number;
  views: number;
  tocart_count: number;
  position_category: number | null;
  current_price_rub: number | null;
  ad_spend_rub: number;
}

export interface MarketplaceSalesResponse {
  period_days: number;
  totals: {
    ozon: MarketplaceSalesTotal;
    wb: MarketplaceSalesTotal;
  };
  daily: MarketplaceSalesDailyRow[];
  top_skus: {
    ozon: MarketplaceSalesTopRow[];
    wb: MarketplaceSalesTopRow[];
  };
}

export async function getMarketplaceSales(days: number = 7) {
  return apiGet<MarketplaceSalesResponse>(`/api/marketplaces/sales?days=${days}`);
}

// =============================================================================
// Documents — Phase 3.0e
// =============================================================================

export interface OperationDocument {
  id: string;
  document_number: string;
  document_type: string;
  operation_id: string | null;
  issuer_id: string;
  partner_id: string | null;
  contract_ref: string | null;
  document_date: number;
  currency: string | null;
  total_amount: number | null;
  pdf_r2_url: string | null;
  status: string;
  issuer_name: string | null;
  partner_name: string | null;
  created_at: number;
  updated_at: number;
}

export interface DocumentsListResponse {
  documents: OperationDocument[];
  count: number;
}

export async function getDocuments(filters: { operation_id?: string; partner_id?: string }) {
  const params = new URLSearchParams();
  if (filters.operation_id) params.set('operation_id', filters.operation_id);
  if (filters.partner_id) params.set('partner_id', filters.partner_id);
  return apiGet<DocumentsListResponse>(`/api/documents?${params.toString()}`);
}

export async function issueDocuments(operation_id: string, types?: Array<'CI' | 'PL' | 'IS-V1' | 'IS-V2' | 'UPD' | 'TN'>) {
  const body: { operation_id: string; types?: string[] } = { operation_id };
  if (types && types.length > 0) body.types = types;
  return apiPost<{ issued: string[]; skipped: string[] }>('/api/documents/issue', body);
}

export async function deleteDocument(id: string) {
  return apiDelete<{ id: string }>(`/api/documents/${id}`);
}

export async function deleteAttachment(id: string) {
  return apiDelete<{ id: string }>(`/api/attachments/${id}`);
}

// =============================================================================
// Inventory actions — Phase 4.5
// =============================================================================

export interface StockMovementResult {
  id: string;
  warehouse_id: string;
  product_id: string;
  movement_type: string;
  quantity: number;
  balance_after: number;
  created_at: number;
}

export interface CreateMovementBody {
  warehouse_id: string;
  product_id: string;
  movement_type: 'receipt' | 'adjustment' | 'session_correction' | 'write_off' | 'opening_balance';
  quantity: number;
  reason?: string | null;
  notes?: string | null;
  performed_by?: string | null;
  performed_at?: number;
}

export async function createStockMovement(body: CreateMovementBody) {
  return apiPost<StockMovementResult>('/api/stock-movements', body);
}

export interface CreateInventorySessionBody {
  warehouse_id: string;
  scope: 'full' | 'partial' | 'spot';
  notes?: string | null;
  started_by?: string | null;
}

export async function createInventorySession(body: CreateInventorySessionBody) {
  return apiPost<InventorySession>('/api/inventory-sessions', body);
}


// =============================================================================
// Banks — Modulbank (Phase 7.0+)
// =============================================================================

export interface BankAccount {
  id: string;
  company_id: string;
  account_number: string;
  account_purpose: string;
  currency: string;
  is_default: 0 | 1;
  bank_provider_id: string | null;
  external_account_id: string | null;
  external_company_id: string | null;
  api_enabled: 0 | 1;
  last_sync_at: number | null;
  notes: string | null;
  is_visible_in_ui?: 0 | 1;
  bank_code?: string | null;
  branch_number?: string | null;
  routing_number?: string | null;
  account_iban?: string | null;
  account_holder?: string | null;
  company_abbreviation: string;
  company_legal_name: string;
  company_tax_id: string | null;
  company_kpp: string | null;
  company_ogrn: string | null;
  company_registered_address: string | null;
  bank_name: string | null;
  bank_address?: string | null;
  bank_legal_name: string | null;
  bank_legal_name_ru: string | null;
  bank_bic: string | null;
  bank_swift: string | null;
  bank_correspondent_account: string | null;
  bank_country: string | null;
  bank_auth_method: 'static_token' | 'oauth2' | 'manual' | null;
  bank_provider_name?: string | null;
}

export interface BankTransaction {
  id: string;
  company_bank_account_id: string;
  external_id: string;
  external_doc_number: string | null;
  direction: 'incoming' | 'outgoing';
  status: string;
  amount: number;
  currency: string;
  executed_at: number;
  created_at_bank: number;
  contragent_name: string | null;
  contragent_inn: string | null;
  contragent_account: string | null;
  contragent_bank_name: string | null;
  contragent_bank_bic: string | null;
  payment_purpose: string | null;
  matched_payment_id: string | null;
  matched_operation_id?: string | null;
  match_status?: 'matched' | 'pending' | 'assign' | null;
  match_method: string | null;
  matched_at: number | null;
  account_number: string;
  account_purpose: string;
  company_abbreviation: string;
  company_legal_name: string;
}

export async function getBankAccounts() {
  return apiGet<{ count: number; accounts: BankAccount[] }>('/api/banks/modulbank/accounts');
}

export async function getBankTransactions(params?: {
  account_id?: string;
  direction?: 'incoming' | 'outgoing';
  matched?: 'true' | 'false';
  limit?: number;
}) {
  const search = new URLSearchParams();
  if (params?.account_id) search.set('account_id', params.account_id);
  if (params?.direction) search.set('direction', params.direction);
  if (params?.matched) search.set('matched', params.matched);
  if (params?.limit) search.set('limit', String(params.limit));
  const qs = search.toString();
  return apiGet<{ count: number; transactions: BankTransaction[] }>(
    `/api/banks/modulbank/transactions${qs ? `?${qs}` : ''}`
  );
}

export async function syncBankHistory(body?: {
  account_id?: string;
  from?: string;
  till?: string;
  page_size?: number;
  max_pages?: number;
}) {
  return apiPost<{
    range: { from: string; till: string };
    accounts_synced: number;
    total_fetched: number;
    total_inserted: number;
    total_updated: number;
    summary: Array<{
      account_id: string; account_number: string;
      fetched: number; inserted: number; updated: number; pages: number;
      error?: string;
    }>;
  }>('/api/banks/modulbank/sync-history', body ?? {});
}

// =============================================================================
// Bank statement sources (email inboxes for emailer-skill auto-import)
// =============================================================================
export interface BankStatementSource {
  id: string;
  email?: string;
  address?: string;
  source_type?: string;
  company_id: string;
  company_abbreviation: string;
  company_legal_name: string;
  is_active: number;
  notes: string | null;
  created_at: number;
  updated_at: number;
}

export async function getBankStatementSources() {
  return apiGet<{ sources: BankStatementSource[] }>('/api/bank-statement-sources');
}

export async function createBankStatementSource(body: {
  email?: string;
  address?: string;
  source_type?: string;
  company_id: 'dee' | 'dei' | 'dasean' | 'dec';
  notes?: string;
}) {
  return apiPost<{ source: BankStatementSource }>('/api/bank-statement-sources', body);
}

export async function deleteBankStatementSource(id: string) {
  return apiDelete<{ id: string; deleted: boolean }>(`/api/bank-statement-sources/${id}`);
}

// =============================================================================
// Operation document sources (Telegram/Email contacts who forward invoices,
// service bills, contracts, etc. AI classifies each incoming doc and routes
// it into the Triage pipeline → draft Purchase / Service / Contract.)
// =============================================================================
export interface OperationDocumentSource {
  id: string;
  source_type: 'email_inbox' | 'telegram_contact';
  address: string;
  company_id: string;
  is_active: number;
  notes: string | null;
  created_at: number;
  updated_at: number;
}

export async function getOperationDocumentSources() {
  return apiGet<{ sources: OperationDocumentSource[] }>('/api/operation-document-sources');
}

export async function createOperationDocumentSource(body: {
  source_type: 'email_inbox' | 'telegram_contact';
  address: string;
  company_id: 'dee' | 'dei' | 'dasean' | 'dec';
  notes?: string;
}) {
  return apiPost<{ source: OperationDocumentSource }>('/api/operation-document-sources', body);
}

export async function updateOperationDocumentSource(id: string, body: {
  company_id?: 'dee' | 'dei' | 'dasean' | 'dec';
  is_active?: boolean;
  notes?: string;
}) {
  return apiPatch<{ id: string; updated: boolean }>(`/api/operation-document-sources/${id}`, body);
}

export async function deleteOperationDocumentSource(id: string) {
  return apiDelete<{ id: string; deleted: boolean }>(`/api/operation-document-sources/${id}`);
}

// =============================================================================
// Operation arrival confirmation/rejection (F4 flow)
// =============================================================================
export async function confirmOperationArrival(operationId: string) {
  return apiPost<{ operation_id: string; status: string }>(`/api/operations/${operationId}/confirm-arrival`, {});
}

export async function rejectOperationArrival(operationId: string) {
  return apiPost<{ operation_id: string; status: string }>(`/api/operations/${operationId}/reject-arrival`, {});
}

// =============================================================================
// Bank statement upload — multipart/form-data
// =============================================================================
export interface UploadStatementResult {
  filename: string;
  r2_key: string;
  account_number: string | null;
  period_from: string | null;
  period_to: string | null;
  summary: {
    total: number;
    inserted: number;
    skipped: number;
    errors: number;
    account_id: string | null;
    account_match_method: 'exact' | 'currency_only' | 'none';
  };
}

export async function uploadBankStatement(file: File, companyId?: string) {
  const form = new FormData();
  form.append('file', file);
  if (companyId) form.append('company_id', companyId);

  const res = await fetch(`${API_BASE}/api/bank-statements/upload`, {
    method: 'POST',
    body: form,
  });

  if (!res.ok) {
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      return json as { success: false; result: null; errors: Array<{ code: string; message: string }> };
    } catch {
      return {
        success: false as const,
        result: null,
        errors: [{ code: 'http_error', message: `HTTP ${res.status}: ${text.slice(0, 200)}` }],
        messages: [],
      };
    }
  }

  return res.json() as Promise<{
    success: boolean;
    result: UploadStatementResult | null;
    errors: Array<{ code: string; message: string }>;
    messages: string[];
  }>;
}

// =============================================================================
// Operation document upload — multipart/form-data, DeepSeek auto-match
// =============================================================================
export interface OperationCandidate {
  id: string;
  reference: string;
  status: string;
  operation_date: number;
  total_amount: number | null;
  currency: string | null;
  partner_name: string | null;
}

export interface ExtractedDocInfo {
  operation_reference: string | null;
  doc_type: string;
  doc_number: string | null;
  doc_date: string | null;
  currency: string | null;
  amount: number | null;
  issuer: string | null;
  counterparty: string | null;
  direction: 'outgoing' | 'incoming';
  confidence: number;
  notes: string;
  line_items?: ExtractedLineItem[];
}

// Pre-filled fields for "Create new operation from this document" UX.
// Backend resolves partner/manufacturer/company via fuzzy match on the
// LLM-extracted issuer + counterparty names.
export interface UploadDocPrefill {
  partner_id: string | null;
  partner_name: string | null;
  manufacturer_id: string | null;
  manufacturer_name: string | null;
  our_company_id: string | null;
  our_company_abbr: string | null;
  operation_type: 'sale' | 'purchase' | 'transfer' | 'service' | 'tax' | null;
  currency: string | null;
  amount: number | null;
  doc_date: string | null;
  r2_key: string;
  filename: string;
  file_mime: string;
  file_size: number;
}

export type UploadDocResult =
  | {
      mode: 'auto_attached';
      operation_id: string;
      operation_reference: string;
      attachment_id: string;
      file_url: string;
      extracted: ExtractedDocInfo;
    }
  | {
      mode: 'manual_attached';
      operation_id: string;
      operation_reference: string;
      attachment_id: string;
      file_url: string;
    }
  | {
      mode: 'low_confidence' | 'no_match' | 'unreadable' | 'no_llm';
      r2_key?: string;
      filename: string;
      file_size?: number;
      file_mime?: string;
      extracted?: ExtractedDocInfo;
      suggestion?: { id: string; reference: string } | null;
      candidates?: OperationCandidate[];
      prefill?: UploadDocPrefill;
      message?: string;
    };

// =============================================================================
// Create stub operation from already-uploaded document
// =============================================================================
export interface ExtractedLineItem {
  description: string;
  sku_hint: string | null;
  qty: number;
  unit_price: number;
  line_amount: number;
  hs_code: string | null;
  cartons: number | null;
}

export interface CreateFromDocBody {
  operation_type: 'sale' | 'purchase' | 'transfer' | 'service' | 'tax';
  operation_date: number;
  partner_id?: string | null;
  manufacturer_id?: string | null;
  our_company_id: string;
  receiving_company_id?: string | null;
  currency: string;
  total_amount?: number | null;
  warehouse_from_id?: string | null;
  warehouse_to_id?: string | null;
  notes?: string | null;
  r2_key: string;
  filename: string;
  file_mime: string;
  doc_type?: string;
  doc_number?: string | null;
  doc_date?: string | null;
  issuer?: string | null;
  direction?: 'incoming' | 'outgoing';
  line_items?: ExtractedLineItem[];
}

export interface CreateFromDocResult {
  operation: {
    id: string;
    reference: string;
    operation_type: 'sale' | 'purchase' | 'transfer' | 'service' | 'tax';
    operation_date: number;
    partner_id: string | null;
    manufacturer_id: string | null;
    our_company_id: string;
    our_company_abbr: string;
    receiving_company_id: string | null;
    currency: string;
    total_amount: number | null;
    status: string;
    warehouse_from_id: string | null;
    warehouse_to_id: string | null;
    stub: boolean;
  };
  attachment: {
    id: string;
    file_url: string;
    filename: string;
  };
  line_items_report?: { matched: number; unmatched: number; total: number };
  warnings: string[];
}

export async function createOperationFromDocument(body: CreateFromDocBody) {
  const res = await fetch(`${API_BASE}/api/operations/create-from-document`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return JSON.parse(text) as {
      success: boolean;
      result: CreateFromDocResult | null;
      errors: Array<{ code: string; message: string }>;
      messages: string[];
    };
  } catch {
    return {
      success: false as const,
      result: null,
      errors: [{ code: 'http_error', message: `HTTP ${res.status}: ${text.slice(0, 200)}` }],
      messages: [],
    };
  }
}

export async function uploadOperationDocument(file: File, operationId?: string) {
  const form = new FormData();
  form.append('file', file);
  if (operationId) form.append('operation_id', operationId);

  const res = await fetch(`${API_BASE}/api/operations/upload-document`, {
    method: 'POST',
    body: form,
  });

  if (!res.ok) {
    const text = await res.text();
    try {
      return JSON.parse(text) as { success: false; result: null; errors: Array<{ code: string; message: string }> };
    } catch {
      return {
        success: false as const,
        result: null,
        errors: [{ code: 'http_error', message: `HTTP ${res.status}: ${text.slice(0, 200)}` }],
        messages: [],
      };
    }
  }

  return res.json() as Promise<{
    success: boolean;
    result: UploadDocResult | null;
    errors: Array<{ code: string; message: string }>;
    messages: string[];
  }>;
}

// =============================================================================
// Finance categories + bank match rules
// =============================================================================
export interface FinanceCategory {
  id: string;
  code: string;
  label: string;
  description: string | null;
  direction: 'incoming' | 'outgoing' | 'any';
  default_operation_type: 'sale' | 'purchase' | 'transfer' | 'service' | 'tax';
  default_partner_kind: string | null;
  always_confirm: number;
  sort_order: number;
  color: string | null;
  icon: string | null;
  rule_count?: number;
  tx_count?: number;
  created_at: number;
  updated_at: number;
}

export interface BankMatchRule {
  id: string;
  category_id: string | null;
  partner_id: string | null;
  contragent_inn: string | null;
  contragent_iban: string | null;
  purpose_pattern: string | null;
  direction: 'incoming' | 'outgoing' | 'any';
  default_operation_type: string | null;
  default_our_company_id: string | null;
  hit_count: number;
  last_hit_at: number | null;
  category_label?: string;
  category_color?: string;
  partner_name?: string;
  partner_kind?: string;
  company_abbreviation?: string;
  notes: string | null;
  created_at: number;
}

export async function getFinanceCategories() {
  return apiGet<{ categories: FinanceCategory[] }>('/api/finance-categories');
}
export async function createFinanceCategory(data: Partial<FinanceCategory>) {
  return apiPost<{ category: FinanceCategory }>('/api/finance-categories', data);
}
export async function updateFinanceCategory(id: string, data: Partial<FinanceCategory>) {
  return apiPatch<{ category: FinanceCategory }>(`/api/finance-categories/${id}`, data);
}
export async function deleteFinanceCategory(id: string) {
  return apiDelete<{ id: string }>(`/api/finance-categories/${id}`);
}

export async function getBankMatchRules(categoryId?: string) {
  const qs = categoryId ? `?category_id=${encodeURIComponent(categoryId)}` : '';
  return apiGet<{ rules: BankMatchRule[] }>(`/api/bank-match-rules${qs}`);
}
export async function createBankMatchRule(data: Partial<BankMatchRule>) {
  return apiPost<{ rule: BankMatchRule }>('/api/bank-match-rules', data);
}
export async function updateBankMatchRule(id: string, data: Partial<BankMatchRule>) {
  return apiPatch<{ id: string }>(`/api/bank-match-rules/${id}`, data);
}
export async function deleteBankMatchRule(id: string) {
  return apiDelete<{ id: string }>(`/api/bank-match-rules/${id}`);
}

export async function previewRuleClassification(input: {
  contragent_inn?: string | null;
  contragent_iban?: string | null;
  payment_purpose?: string | null;
  direction: 'incoming' | 'outgoing';
}) {
  return apiPost<{
    result: { category_id: string | null; confidence: number; source: string | null; reason: string };
    decision: { action: 'auto_classify' | 'inbox_suggest' | 'inbox_blank'; category_id: string | null; reason: string };
    category: FinanceCategory | null;
  }>('/api/bank-match-rules/preview', input);
}

// =============================================================================
// Agent Settlements — triangle settlement (DEE → Bright Ideas + Centuno → DEI)
// =============================================================================
export interface AgentSettlement {
  id: string;
  reference: string;
  settlement_date: number;
  status: 'draft' | 'pending_match' | 'settled' | 'cancelled';
  notes: string | null;
  outbound_amount: number;
  outbound_currency: string;
  inbound_amount: number;
  inbound_currency: string;
  variance_amount: number | null;
  variance_currency: string | null;
  exchange_rate: number | null;
  clearance_operation_id: string | null;
  clearance_op_reference: string | null;
  outbound_company: string;
  inbound_company: string;
  outbound_agent_name: string;
  inbound_agent_name: string;
  outbound_bank_tx_id: string | null;
  inbound_bank_tx_id: string | null;
}

export interface AgentSettlementDetail extends AgentSettlement {
  outbound_company_id: string;
  inbound_company_id: string;
  outbound_agent_partner_id: string;
  inbound_agent_partner_id: string;
  clearance_creditor_company_id: string | null;
  clearance_debtor_company_id: string | null;
  clearance_creditor_company: string | null;
  clearance_debtor_company: string | null;
  paper_invoice_document_id: string | null;
  clearance_op_total: number | null;
  clearance_op_currency: string | null;
  clearance_op_status: string | null;
  clearance_op_partner_name: string | null;
  outbound_purpose: string | null;
  outbound_contragent: string | null;
  outbound_executed_at: number | null;
  inbound_purpose: string | null;
  inbound_contragent: string | null;
  inbound_executed_at: number | null;
  created_at: number;
  updated_at: number;
}

export async function getAgentSettlements(filters?: { status?: string; company_id?: string }) {
  const qs = new URLSearchParams();
  if (filters?.status) qs.set('status', filters.status);
  if (filters?.company_id) qs.set('company_id', filters.company_id);
  const suffix = qs.toString() ? `?${qs}` : '';
  return apiGet<{ settlements: AgentSettlement[] }>(`/api/agent-settlements${suffix}`);
}

export async function getAgentSettlement(id: string) {
  return apiGet<AgentSettlementDetail>(`/api/agent-settlements/${id}`);
}

export async function createAgentSettlement(data: {
  outbound_bank_tx_id?: string | null;
  inbound_bank_tx_id?: string | null;
  outbound_company_id: string;
  inbound_company_id: string;
  outbound_agent_partner_id: string;
  inbound_agent_partner_id: string;
  outbound_amount: number;
  outbound_currency: string;
  inbound_amount: number;
  inbound_currency: string;
  settlement_date?: string;
  clearance_operation_id?: string | null;
  clearance_creditor_company_id?: string | null;
  clearance_debtor_company_id?: string | null;
  exchange_rate?: number | null;
  variance_amount?: number | null;
  variance_currency?: string | null;
  notes?: string | null;
}) {
  return apiPost<{ id: string; reference: string; status: string }>('/api/agent-settlements', data);
}

export async function updateAgentSettlement(id: string, data: Partial<AgentSettlementDetail> & Record<string, unknown>) {
  return apiPatch<{ id: string; updated: number }>(`/api/agent-settlements/${id}`, data);
}

export async function cancelAgentSettlement(id: string) {
  return apiPost<{ id: string; status: string }>(`/api/agent-settlements/${id}/cancel`, {});
}

export interface SettlementSuggestion {
  outbound: { bank_tx_id: string; executed_at: number; amount: number; currency: string; contragent_name: string; payment_purpose: string | null; op_id: string; op_reference: string; partner_id: string; partner_name: string; company_id: string; company_abbr: string };
  inbound:  { bank_tx_id: string; executed_at: number; amount: number; currency: string; contragent_name: string; payment_purpose: string | null; op_id: string; op_reference: string; partner_id: string; partner_name: string; company_id: string; company_abbr: string };
  days_apart: number;
  implied_rate: number | null;
}

export async function suggestAgentSettlements(window_days = 60, min_amount = 5000) {
  return apiPost<{ suggestions: SettlementSuggestion[]; candidates: { outbound: number; inbound: number } }>(
    '/api/agent-settlements/suggest',
    { window_days, min_amount }
  );
}

export interface AvailableAgentBankTx {
  id: string;
  executed_at: number;
  amount: number;
  currency: string;
  direction: 'incoming' | 'outgoing';
  contragent_name: string | null;
  payment_purpose: string | null;
  matched_operation_id: string | null;
  company_id: string;
  company_abbr: string;
  match_method: string | null;
}

export async function getAvailableAgentBankTxs(direction: 'incoming' | 'outgoing') {
  return apiGet<{ transactions: AvailableAgentBankTx[] }>(`/api/agent-settlements/available-bank-txs?direction=${direction}`);
}

// =============================================================================
// Document extraction review queue (/api/document-extractions)
// =============================================================================

export interface ExtractionFieldRef {
  value: string | number | null;
  raw: string | null;
  confidence: number;
  source: string | null;
  alternatives: Array<{ value: string; label?: string; confidence?: number; why?: string }>;
  needs_review: boolean;
}

export interface ExtractionLineItem {
  description: string;
  qty: number;
  unit_price: number;
  line_amount: number;
  cartons: number | null;
  hs_code: string | null;
  product_id: string | null;
  product_id_source?: string;
  product_id_confidence?: number;
  product_id_alternatives?: Array<{ value: string; label?: string; confidence?: number; why?: string }>;
  needs_review?: boolean;
}

export interface ExtractionValidationCheck {
  code: string;
  label: string;
  passed: boolean;
  severity: 'info' | 'warning' | 'error';
  details?: string;
}

export interface DocumentExtraction {
  id: string;
  filename: string;
  document_kind: string;
  status: string;
  overall_confidence: number;
  target_table: string;
  target_action: string;
  target_id: string | null;
  created_at: number;
  header_fields: Record<string, ExtractionFieldRef>;
  line_items: ExtractionLineItem[];
  validation: {
    checks: ExtractionValidationCheck[];
    passed_count: number;
    failed_count: number;
    warnings_count: number;
    errors_count: number;
    ready_for_auto_commit: boolean;
  } | null;
}

export async function getExtraction(id: string) {
  return apiGet<{ extraction: DocumentExtraction }>(`/api/document-extractions/${id}`);
}

export async function listExtractions(status = 'pending_review') {
  return apiGet<{ extractions: DocumentExtraction[]; count: number }>(`/api/document-extractions?status=${encodeURIComponent(status)}`);
}

export async function patchExtractionHeader(id: string, field: string, value: unknown) {
  return apiPatch<{ field: string; value: unknown }>(`/api/document-extractions/${id}/header`, { field, value });
}

export async function patchExtractionLine(id: string, idx: number, field: string, value: unknown) {
  return apiPatch<{ idx: number; field: string; value: unknown }>(`/api/document-extractions/${id}/line-item/${idx}`, { field, value });
}

export async function approveExtraction(id: string) {
  return apiPost<{ id: string; status: string; target_id: string; reference?: string }>(`/api/document-extractions/${id}/approve`, {});
}

export async function rejectExtraction(id: string, reason?: string) {
  return apiPost<{ id: string; status: string }>(`/api/document-extractions/${id}/reject`, { reason: reason ?? null });
}

export function extractionFileUrl(id: string): string {
  return `${API_BASE}/api/document-extractions/${id}/file`;
}


// =============================================================================
// Emailer (/api/email)
// =============================================================================

export interface EmailThread {
  thread_id: string;
  subject: string;
  snippet: string;
  from: string;
  to: string;
  date: string;
  has_attachments: boolean;
  labels: string[];
}

export interface EmailHistoryResponse {
  threads: EmailThread[];
  total: number;
  query: string;
  has_more?: boolean;
  start?: number;
}

export async function getEmailHistory(query = 'newer_than:30d', limit = 50, offset = 0, fresh = false) {
  const freshParam = fresh ? '&fresh=1' : '';
  return apiGet<EmailHistoryResponse>(`/api/email/history?query=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}${freshParam}`);
}

// ---------------------------------------------------------------------------
// Cloudflare Inbox archive — read-only client for api/src/lib/inbox-archive.ts.
// Independent of the Gmail/EMAILER bridge above: this reads the R2
// Inbox/<mailbox>/... records written by the notify.dasexperten.com senders.
// ---------------------------------------------------------------------------

export interface MailboxSummary {
  address: string;
  count: number;
  last_activity: string | null;
}

export interface MailboxIndexEntry {
  key: string;
  direction: 'sent' | 'received';
  timestamp: string;
  subject: string;
  from?: string;
  to?: string | string[];
  messageId?: string;
  threadId?: string;
  /** Thread tag issued in Reply-To and echoed back on the counterparty's answer. */
  plusTag?: string;
  origin?: 'human' | 'auto';
  trigger?: string;
}

export interface MailboxMessageRecord {
  direction: 'sent' | 'received';
  address: string;
  timestamp: string;
  to?: string | string[];
  from?: string;
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  text?: string;
  html?: string;
  messageId?: string;
  threadId?: string;
}

export async function getMailboxes() {
  return apiGet<{ mailboxes: MailboxSummary[] }>('/api/email/mailboxes');
}

/** Agents + Departments accordion data (registry + R2 counts). Owner not included. */
export async function getEmailNav() {
  return apiGet<{
    agents: Array<{
      address: string;
      label: string;
      role: string | null;
      slug: string | null;
      avatar_url: string | null;
      count: number;
      last_activity: string | null;
    }>;
    departments: Array<{
      address: string;
      label: string;
      role: string | null;
      slug: string | null;
      avatar_url: string | null;
      count: number;
      last_activity: string | null;
    }>;
    owner: {
      address: string;
      show_in_ui: false;
      inbound: 'forward_gmail';
      forward_to: string;
      note: string;
    };
  }>('/api/email/nav');
}

export async function getMailboxMessages(address: string) {
  return apiGet<{ address: string; entries: MailboxIndexEntry[] }>(
    `/api/email/mailboxes/${encodeURIComponent(address)}`
  );
}

export async function getMailboxMessage(address: string, key: string) {
  return apiGet<{ record: MailboxMessageRecord }>(
    `/api/email/mailboxes/${encodeURIComponent(address)}/message?key=${encodeURIComponent(key)}`
  );
}

// ---------------------------------------------------------------------------
// Counterparty context for one letter, and that counterparty's history.
//
// Two calls on purpose. The header renders as soon as we know WHO wrote; the
// history fills in after. One merged call would make the panel appear later
// and feel slower, even at the same total cost.
// ---------------------------------------------------------------------------
export interface EmailContextPartner {
  id: string; slug: string; trade_name: string;
  country?: string | null; partner_type?: string | null;
  status?: string | null; email?: string | null;
  created_by_agent?: string | null;
  owner_agent?: string | null;
}

export interface EmailContextOperation {
  id: string; reference?: string | null; order_doc_ref?: string | null;
  operation_type?: string | null; status?: string | null; operation_date?: number | null;
}

export interface EmailContext {
  link: {
    id: string; counterpartyEmail?: string | null; source: string;
    confidence: number; matchedOn?: string | null; locked: boolean;
  } | null;
  partner: EmailContextPartner | null;
  operation: EmailContextOperation | null;
  stats: { letters?: number; operations?: number } | null;
}

export async function getEmailContext(key: string) {
  return apiGet<EmailContext>(`/api/email/context?key=${encodeURIComponent(key)}`);
}

export interface TimelineEvent {
  kind: 'email' | 'operation' | 'document' | 'payment';
  at: number;
  title: string;
  subtitle?: string;
  direction?: 'sent' | 'received';
  status?: string;
}

export async function getPartnerTimeline(slug: string, limit = 8) {
  return apiGet<{
    partner: { id: string; slug: string; tradeName: string };
    events: TimelineEvent[];
    counts: Record<string, number>;
  }>(`/api/partners/${encodeURIComponent(slug)}/timeline?limit=${limit}`);
}

export interface Correspondent {
  address: string;
  letters: number;
  mailboxes: string[];
  lastAt: string;
  lastSubject: string;
  partnerSlug?: string;
  partnerName?: string;
}

export async function getCorrespondents(all = false) {
  return apiGet<{ total: number; unknownCount: number; rows: Correspondent[] }>(
    `/api/email/correspondents?limit=200${all ? '&all=1' : ''}`
  );
}

export async function relinkArchive(offset = 0) {
  const token = typeof window !== 'undefined' ? window.localStorage.getItem('dx_auth_token') : null;
  const res = await fetch(`${API_BASE}/api/email/correspondents/relink?offset=${offset}&limit=120`, {
    method: 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  try {
    return await res.json() as {
      success: boolean;
      result?: { total: number; processed: number; linked: number; nextOffset: number; remaining: number };
    };
  } catch { return { success: false }; }
}

export async function linkLetterToPartner(input: {
  key: string; partner_id?: string | null; operation_id?: string | null;
  counterparty_email?: string;
}) {
  const token = typeof window !== 'undefined' ? window.localStorage.getItem('dx_auth_token') : null;
  const res = await fetch(`${API_BASE}/api/email/context/link`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(input),
  });
  try { return await res.json(); } catch { return { success: false }; }
}

export async function createPartnerQuick(input: {
  trade_name: string; email?: string; kind?: string; country?: string | null;
  created_by_agent?: string | null; owner_agent?: string | null;
}) {
  const token = typeof window !== 'undefined' ? window.localStorage.getItem('dx_auth_token') : null;
  const res = await fetch(`${API_BASE}/api/partners`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ kind: 'other', ...input }),
  });
  try { return await res.json(); } catch { return { success: false }; }
}

// 2-sentence AI summary of a message body (cached server-side).
export async function getMailboxMessageSummary(address: string, key: string) {
  return apiGet<{ summary: string; cached: boolean }>(
    `/api/email/mailboxes/${encodeURIComponent(address)}/summary?key=${encodeURIComponent(key)}`
  );
}

// Human reply via Resend. Returns the bare { success, messageId } / { success,
// error } shape the /reply endpoint emits (not the ok()/fail() envelope).
export async function sendReply(input: {
  to: string | string[];
  subject: string;
  text: string;
  from?: string;
  cc?: string | string[];
  in_reply_to?: string;
  references?: string[];
  reply_to_tag?: string;
}): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const token =
    typeof window !== 'undefined' ? window.localStorage.getItem('dx_auth_token') : null;
  const res = await fetch(`${API_BASE}/api/email/reply`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(input),
  });
  try {
    return await res.json();
  } catch {
    return { success: false, error: `HTTP ${res.status}` };
  }
}

/**
 * Translate a letter that is neither Russian nor English.
 * Owner 2026-07-31: model is Sonnet, and Sonnet again on the retry — the API
 * route pins prefer:'anthropic' then prefer:'openrouter', never DeepSeek.
 * The source language comes back from the model, not from the client detector.
 */
export async function translateEmail(input: {
  text?: string;
  html?: string;
  /** Defaults to Russian on the server. */
  target?: string;
}): Promise<{
  success: boolean;
  translation?: string;
  sourceLanguage?: string;
  truncated?: boolean;
  error?: string;
}> {
  const token =
    typeof window !== 'undefined' ? window.localStorage.getItem('dx_auth_token') : null;
  try {
    const res = await fetch(`${API_BASE}/api/email/translate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(input),
    });
    const j = (await res.json()) as {
      success?: boolean;
      result?: { translation?: string; sourceLanguage?: string; truncated?: boolean };
      errors?: { message?: string }[];
    };
    if (!res.ok || !j.success) {
      return { success: false, error: j.errors?.[0]?.message || `HTTP ${res.status}` };
    }
    return {
      success: true,
      translation: j.result?.translation ?? '',
      sourceLanguage: j.result?.sourceLanguage ?? '',
      truncated: j.result?.truncated ?? false,
    };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'network error' };
  }
}

/**
 * Ask the AGENT — on the agent's own Worker, with its charter, memory and name.
 * Owner 2026-07-30: this used to call the shared drafting service, whose prompt
 * names the Owner as the author, so Lauda's replies went out signed as Aram.
 * Backend: POST /api/email-tasks/agent-draft — session-authed, resolves the
 * mailbox from the archive key and proxies to that seat through a service
 * binding. Returns text only; the draft opens in the compose window and the
 * human presses Отправить.
 */
export async function draftAgentReply(input: {
  /** The archived letter. The agent is resolved from the mailbox in this key. */
  key: string;
}): Promise<{ success: boolean; draft?: string; by?: string; error?: string }> {
  const token =
    typeof window !== 'undefined' ? window.localStorage.getItem('dx_auth_token') : null;
  try {
    const res = await fetch(`${API_BASE}/api/email-tasks/agent-draft`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(input),
    });
    const json = (await res.json()) as {
      success?: boolean;
      result?: { draft?: string; by?: string };
      errors?: Array<{ message?: string }>;
    };
    if (!json.success || !json.result?.draft) {
      return { success: false, error: json.errors?.[0]?.message || `HTTP ${res.status}` };
    }
    return { success: true, draft: json.result.draft, by: json.result.by };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'network error' };
  }
}

// 3-4 line "what they want" digest for the dark message screen (?v=2).
export async function getMailboxMessageSummaryV2(address: string, key: string) {
  return apiGet<{ summary: string; cached: boolean }>(
    `/api/email/mailboxes/${encodeURIComponent(address)}/summary?key=${encodeURIComponent(key)}&v=2`
  );
}

// ---------------------------------------------------------------------------
// Emailer Dark UI v3 — state layer (read/unread, attention, orders feed).
// ---------------------------------------------------------------------------

export async function markMailRead(keys: string[], mailbox: string) {
  return apiPost<{ marked: number }>('/api/email/read', { keys, mailbox });
}

export async function markMailUnread(keys: string[]) {
  return apiPost<{ unmarked: number }>('/api/email/unread', { keys });
}

export interface EmailFeedFlag {
  message_key: string;
  mailbox?: string;
  starred: number;
  archived: number;
  trashed: number;
}

export interface EmailFeedDraft {
  id: string;
  mailbox: string;
  to_addr: string;
  cc_addr: string;
  subject: string;
  body: string;
  in_reply_to: string | null;
  updated_at: number;
}

export async function getEmailFeed(fresh = false) {
  const token =
    typeof window !== 'undefined' ? window.localStorage.getItem('dx_auth_token') : null;
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const t = ctrl ? setTimeout(() => ctrl.abort(), 12000) : null;
  try {
    const res = await fetch(
      `${API_BASE}/api/email/feed${fresh ? '?fresh=1' : ''}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(ctrl ? { signal: ctrl.signal } : {}),
      },
    );
    handleAuthFailure(res.status);
    return await res.json() as ApiResponse<{
      entries: Array<MailboxIndexEntry & { mailbox: string }>;
      flags: EmailFeedFlag[];
      read: string[];
      drafts: EmailFeedDraft[];
    }>;
  } catch (e) {
    return {
      success: false,
      result: null,
      errors: [{ code: 'timeout', message: 'Нет ответа от сервера — нажмите Ещё раз' }],
      messages: [],
    };
  } finally {
    if (t) clearTimeout(t);
  }
}

export async function setMailFlags(items: Array<{
  message_key: string;
  mailbox: string;
  starred: boolean;
  archived: boolean;
  trashed: boolean;
}>) {
  return apiPost<{ updated: number }>('/api/email/flags', { items });
}

export async function saveMailDraft(draft: {
  id?: string;
  mailbox: string;
  to: string;
  cc?: string;
  subject: string;
  body: string;
  in_reply_to?: string;
}) {
  return apiPut<{ id: string }>('/api/email/drafts', draft);
}

export async function deleteMailDraft(id: string) {
  return apiDelete<{ deleted: boolean }>(`/api/email/drafts/${encodeURIComponent(id)}`);
}

export async function getUnreadCount(group: 'human' | 'system') {
  return apiGet<{ group: string; count: number }>(`/api/email/unread-count?group=${group}`);
}

export interface AttentionEntry {
  correspondent: string;
  subject: string;
  sent_at: string;
  hours_waiting: number;
}

export async function getAttention() {
  return apiGet<{ count: number; waiting: AttentionEntry[] }>('/api/email/attention');
}

export interface OrderFeedItem {
  key: string;
  mailbox: string;
  direction: 'sent' | 'received';
  trigger: string;
  subject: string;
  timestamp: string;
  correspondent: string;
  status: 'new' | 'processed';
}

export async function getOrdersFeed(period: '24h' | '7d') {
  return apiGet<{ period: string; count: number; items: OrderFeedItem[] }>(`/api/email/orders?period=${period}`);
}

export type EmailRuleAction = 'exclude' | 'attention' | 'keep' | 'delete' | 'forward' | 'archive';

export interface EmailRule {
  id: string;
  match_sender: string | null;
  email_type: string | null;
  action: EmailRuleAction;
  target: string | null;
  source: 'manual' | 'learned';
  confidence: number | null;
  enabled: boolean;
  match_count: number;
  last_matched_at: number | null;
  created_at: number;
  updated_at: number;
}

export async function getEmailRules() {
  return apiGet<{ rules: EmailRule[] }>('/api/email/rules');
}

export async function createEmailRule(data: {
  match_sender?: string;
  email_type?: string;
  action: EmailRuleAction;
  target?: string;
  source?: 'manual' | 'learned';
  confidence?: number;
  enabled?: boolean;
}) {
  return apiPost<EmailRule>('/api/email/rules', data);
}

export async function updateEmailRule(
  id: string,
  data: { match_sender?: string; email_type?: string; action?: EmailRuleAction; target?: string; enabled?: boolean },
) {
  return apiPatch<EmailRule>(`/api/email/rules/${id}`, data);
}

export async function deleteEmailRule(id: string) {
  return apiDelete<{ deleted: boolean }>(`/api/email/rules/${id}`);
}

export async function inboxAction(data: {
  thread_id: string;
  sender: string;
  subject?: string;
  snippet?: string;
  action: 'delete' | 'forward' | 'file';
  target?: string;
  rule_whole_sender?: boolean;
}) {
  return apiPost<{ action: string; classified_as: string; rule_id: string | null; acted: boolean }>('/api/email/inbox-action', data);
}

export interface SendEmailParams {
  action?: 'send' | 'reply' | 'reply_all';
  recipient?: string;
  from?: string;
  thread_id?: string;
  subject?: string;
  body_plain?: string;
  body_html?: string;
  attachments?: string[];
  context?: string;
  draft_only?: boolean;
}

export async function sendEmail(params: SendEmailParams) {
  return apiPost<{
    success: boolean;
    message_id?: string;
    thread_id?: string;
    draft_id?: string;
    draft_link?: string;
    error?: string;
  }>('/api/email/send', params);
}

export async function getEmailHealth() {
  return apiGet<{
    bridge_binding: string;
    bridge_status: number;
    bridge_ok: boolean;
    probe_method: string;
    latency_ms: number;
  }>('/api/email/health');
}

// ---------------------------------------------------------------------------
// Admin: resync D1 product_prices from Pricer .md pricelists stored in R2.
// ---------------------------------------------------------------------------
export async function resyncPrices(apply: boolean = true) {
  return apiPost('/api/admin/resync-prices', { apply });
}

// -----------------------------------------------------------------------------
// Учи — study one archived letter as the mailbox owner (Owner 2026-07-31).
// The engine is the org board's learn-from-source; this only hands it the letter.
// Reports only what is NEW for that seat vs its charter, skills and playbook.
// -----------------------------------------------------------------------------
export interface LearnReport {
  agent: string;
  agentName: string;
  mailbox: string;
  subject: string;
  from: string;
  ownerMail: boolean;
  /** Claims one of the Owner's addresses but the sender did not verify. */
  unverifiedOwnerClaim: boolean;
  summary: string;
  newIntel: string[];
  alreadyKnew: string[];
  lessons: string[];
  nothingNew: boolean;
  report: string;
  /** How many letters of the conversation were actually read. */
  studied: number;
  /** True when the oldest turns were dropped to stay within budget. */
  truncated: boolean;
}

export async function learnFromLetter(input: {
  key: string;
  /** The whole conversation, oldest first. Omit to study just `key`. */
  keys?: string[];
  note?: string;
}): Promise<{ success: boolean; result?: LearnReport; error?: string }> {
  const token =
    typeof window !== 'undefined' ? window.localStorage.getItem('dx_auth_token') : null;
  try {
    const res = await fetch(`${API_BASE}/api/email/learn`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(input),
    });
    const json = (await res.json()) as {
      success?: boolean;
      result?: LearnReport;
      errors?: Array<{ message?: string }>;
    };
    if (!json.success || !json.result) {
      return { success: false, error: json.errors?.[0]?.message || 'Учи не удалось' };
    }
    return { success: true, result: json.result };
  } catch {
    return { success: false, error: 'Учи не удалось — сеть' };
  }
}
