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
  contract_id: string;
  contract_no?: string | null;
  partner_id: string;
  partner_trade_name?: string | null;
  our_company_id: string;
  entity_abbreviation?: string | null;
  operation_type: 'sale' | 'purchase' | 'transfer';
  operation_date: number;
  warehouse_from_id: string | null;
  warehouse_to_id: string | null;
  manufacturer_id: string | null;
  currency: string;
  fx_rate_to_usd: number | null;
  total_amount: number;
  total_usd_equiv: number | null;
  status: string;
  reference: string | null;
  order_doc_ref: string | null;
  notes: string | null;
  incoterms: string | null;
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
  contract_id: string;
  operation_type: 'sale' | 'purchase' | 'transfer';
  operation_date: number;
  warehouse_from_id?: string;
  warehouse_to_id?: string;
  manufacturer_id?: string;
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
