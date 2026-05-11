// =============================================================================
// Freight RFQ skill — types.
//
// Self-contained: does NOT depend on invoicer's heavy validator/selector
// machinery. RFQ has no manufacturer chain, no buyer-vs-shipper distinction,
// no currency conversion. Just: this operation + this shipper -> document.
// =============================================================================

export interface RfqOperation {
  id: string;
  reference: string | null;
  operation_type: string;
  operation_date: number;
  manufacturer_id: string | null;
  partner_id: string | null;
  warehouse_from_id: string | null;
  warehouse_to_id: string | null;
  incoterms: string | null;
  currency: string;
  total_amount: number;
  status: string;
}

export interface RfqLineItem {
  product_id: string;
  product_name: string | null;
  invoice_label: string | null;
  qty: number;
  cartons: number | null;
  unit_price: number;
}

export interface RfqIssuerCompany {
  id: string;
  legal_name: string;
  legal_name_ru: string | null;
  registered_address: string | null;
  email?: string | null;
}

export interface RfqShipper {
  id: string;
  slug: string;
  trade_name: string;
  legal_name_en: string | null;
  email: string | null;
  country: string | null;
}

export interface RfqOriginLocation {
  name: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
}

export interface RfqDestinationLocation {
  name: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
}

export interface RfqInput {
  operation: RfqOperation;
  lineItems: RfqLineItem[];
  issuer: RfqIssuerCompany;
  shipper: RfqShipper;
  origin: RfqOriginLocation;
  destination: RfqDestinationLocation;
  requestedPickupDate: number | null;
  notes: string | null;
}

export interface RfqIssueResult {
  document_id: string;
  document_number: string;
  r2_key: string;
  download_url: string;
  shipper: {
    id: string;
    name: string;
    email: string | null;
  };
}
