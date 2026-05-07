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

export async function apiPatch<T = unknown>(
  path: string,
  body: unknown
): Promise<ApiResponse<T>> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function apiPut<T = unknown>(
  path: string,
  body: unknown
): Promise<ApiResponse<T>> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'PUT',
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
  description_ru?: string | null;
  description_en?: string | null;
  description_cn?: string | null;
  packaging_manufacturer_id?: string | null;
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
  last_verified?: number | null;
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

// =============================================================================
// Partner CRUD — Phase 5.x
// =============================================================================
export interface CreatePartnerBody {
  trade_name: string;
  partner_type: 'buyer' | 'supplier' | 'shipper' | 'other';
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
  payment_terms: string | null;
  linked_entity_id: string | null;
  price_type_id: string | null;
  currency: string | null;
  notes: string | null;
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
  vat_rate?: 0 | 5 | 20;
}

export async function createContract(body: CreateContractBody) {
  return apiPost<Contract>('/api/contracts', body);
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
  balance_minor: number;
  balance_usd_cents: number;
}

export interface PartnerNetBalance {
  partner_id: string;
  currencies_breakdown: NetBalanceBreakdown[];
  net_balance_usd_cents: number;
  fx_date: string | null;
  calculated_at: number;
}

export async function getPartnerNetBalance(slug: string) {
  return apiGet<PartnerNetBalance>(`/api/partners/${slug}/net-balance`);
}

export interface BulkNetBalances {
  count: number;
  balances: Array<{
    partner_id: string;
    net_balance_usd_cents: number;
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
  operation_type: 'sale' | 'purchase' | 'transfer';
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
  created_at: number;
  updated_at: number;
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
}) {
  const params = new URLSearchParams();
  if (filters?.partner_id) params.set('partner_id', filters.partner_id);
  if (filters?.contract_id) params.set('contract_id', filters.contract_id);
  if (filters?.operation_type) params.set('operation_type', filters.operation_type);
  if (filters?.status) params.set('status', filters.status);
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
  operation_type: 'sale' | 'purchase' | 'transfer';
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
  line_items: CreateOperationLineItem[];
}

export async function createOperation(body: CreateOperationBody) {
  return apiPost<{ operation: Operation; line_items: OperationLineItem[]; warnings: string[] }>(
    '/api/operations',
    body
  );
}

export interface UpdateStatusResponse {
  id: string;
  previous_status: string;
  status: 'shipped' | 'delivered' | 'cancelled';
  updated_at: number;
}

export async function updateOperationStatus(
  id: string,
  status: 'shipped' | 'delivered' | 'cancelled'
) {
  return apiPatch<UpdateStatusResponse>(`/api/operations/${id}/status`, { status });
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
// Products with stock breakdown
// -----------------------------------------------------------------------------

export interface ProductWarehouseStock {
  warehouse_id: string;
  code: string;
  name: string;
  on_hand: number;
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

export async function getMarketplaceSales() {
  return apiGet<MarketplaceSalesResponse>('/api/marketplaces/sales');
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

export async function issueDocuments(operation_id: string) {
  return apiPost<{ issued: string[]; skipped: string[] }>('/api/documents/issue', { operation_id });
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

export interface InventorySession {
  id: string;
  reference: string;
  warehouse_id: string;
  status: string;
  scope: string;
  started_at: number;
  started_by: string | null;
}

export async function createInventorySession(body: CreateInventorySessionBody) {
  return apiPost<InventorySession>('/api/inventory-sessions', body);
}

