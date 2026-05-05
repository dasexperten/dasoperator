import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";

// =============================================================================
// COMPANIES — наши юрлица (DEE, DEI, DEASEAN, DEC)
// =============================================================================
// default_invoice_language CHECK (in 0007): 'EN' / 'RU' / 'BILINGUAL' / NULL
export const companies = sqliteTable("companies", {
  id: text("id").primaryKey(),
  abbreviation: text("abbreviation").notNull().unique(),
  legalName: text("legal_name").notNull(),
  tradeName: text("trade_name"),
  jurisdiction: text("jurisdiction"),
  registrationNo: text("registration_no"),
  taxId: text("tax_id"),
  registeredAddress: text("registered_address"),
  baseCurrency: text("base_currency").notNull(),
  notes: text("notes"),
  // Banking + multilingual + invoice defaults (added by 0007)
  bankName: text("bank_name"),
  bankAccount: text("bank_account"),
  swift: text("swift"),
  iban: text("iban"),
  bankAddress: text("bank_address"),
  legalNameRu: text("legal_name_ru"),
  legalNameLocal: text("legal_name_local"),
  kpp: text("kpp"),
  ogrn: text("ogrn"),
  bankNameEn: text("bank_name_en"),
  bik: text("bik"),
  correspondentAccount: text("correspondent_account"),
  lastVerified: integer("last_verified"),
  signingAuthorityName: text("signing_authority_name"),
  signingAuthorityTitleEn: text("signing_authority_title_en"),
  signingAuthorityTitleRu: text("signing_authority_title_ru"),
  defaultInvoiceLanguage: text("default_invoice_language"),
  preferredIncotermsDomestic: text("preferred_incoterms_domestic"),
  preferredIncotermsInternational: text("preferred_incoterms_international"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  deletedAt: integer("deleted_at"),
}, (t) => ({
  abbrIdx: index("idx_companies_abbreviation").on(t.abbreviation),
}));

// =============================================================================
// COMPANY_BANK_ACCOUNTS — multi-account model for invoicer (0007)
// account_purpose CHECK: primary / rub / cny_usd / usd / eur / reserved_tax
// =============================================================================
export const companyBankAccounts = sqliteTable("company_bank_accounts", {
  id: text("id").primaryKey(),
  companyId: text("company_id").notNull().references(() => companies.id),
  accountPurpose: text("account_purpose").notNull(),
  accountNumber: text("account_number").notNull(),
  currency: text("currency").notNull(),
  notes: text("notes"),
  isDefault: integer("is_default").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  deletedAt: integer("deleted_at"),
}, (t) => ({
  companyIdx: index("idx_cba_company").on(t.companyId),
  purposeIdx: index("idx_cba_purpose").on(t.accountPurpose),
}));

// =============================================================================
// MANUFACTURERS — производители (WDAA, Meizhiyuan, Yangzhou Jinxia)
// =============================================================================
export const manufacturers = sqliteTable("manufacturers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  country: text("country"),
  city: text("city"),
  address: text("address"),
  role: text("role"),
  bankNotes: text("bank_notes"),
  notes: text("notes"),
  // Multilingual identity + dual-route flag (added by 0007)
  hasDualRouteBanking: integer("has_dual_route_banking").notNull().default(0),
  lastVerified: integer("last_verified"),
  legalNameEn: text("legal_name_en"),
  legalNameRu: text("legal_name_ru"),
  legalNameCn: text("legal_name_cn"),
  registeredAddressEn: text("registered_address_en"),
  registeredAddressRu: text("registered_address_ru"),
  taxId: text("tax_id"),  // Chinese USCC
  // Roles + slug (added by 0009)
  slug: text("slug"),
  isPackagingManufacturer: integer("is_packaging_manufacturer").notNull().default(0),
  isLegalSeller: integer("is_legal_seller").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  deletedAt: integer("deleted_at"),
});

// =============================================================================
// MANUFACTURER_BANK_ROUTES — Honghui / Jinxia have two routes each (A / B)
// route_code CHECK: A / B / default
// =============================================================================
export const manufacturerBankRoutes = sqliteTable("manufacturer_bank_routes", {
  id: text("id").primaryKey(),
  manufacturerId: text("manufacturer_id").notNull().references(() => manufacturers.id),
  routeCode: text("route_code").notNull(),
  payerJurisdictionFilter: text("payer_jurisdiction_filter"),
  bankName: text("bank_name").notNull(),
  bankAddress: text("bank_address"),
  accountNumber: text("account_number"),
  iban: text("iban"),
  swift: text("swift").notNull(),
  accountHolder: text("account_holder").notNull(),
  currency: text("currency").notNull(),
  notes: text("notes"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  deletedAt: integer("deleted_at"),
}, (t) => ({
  manufacturerIdx: index("idx_mbr_manufacturer").on(t.manufacturerId),
}));

// =============================================================================
// PRICE_TYPES — типы прайсов (Distributor RUB, Distributor USD, WB_RU и т.д.)
// =============================================================================
export const priceTypes = sqliteTable("price_types", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  description: text("description"),
  currency: text("currency").notNull(),
  usedByEntity: text("used_by_entity"),
  active: integer("active").notNull().default(1),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// =============================================================================
// PRODUCTS — каталог SKU (20 товаров)
// =============================================================================
// id is the SKU in skill-canonical lowercase (de201, de105, …) after the
// rename in 0008_seed_invoicer_data.sql.
export const products = sqliteTable("products", {
  id: text("id").primaryKey(),
  productName: text("product_name").notNull(),
  invoiceLabel: text("invoice_label").notNull(),
  category: text("category").notNull(),         // Toothpaste / Toothbrush
  barcode: text("barcode"),
  weightKg: integer("weight_kg"),               // grams (legacy)
  volumeM3Micro: integer("volume_m3_micro"),    // microlitres × 1000 (legacy)
  manufacturerId: text("manufacturer_id").notNull().references(() => manufacturers.id),
  buyPrice: integer("buy_price"),               // minor units
  buyCurrency: text("buy_currency"),
  buyTerm: text("buy_term"),                    // FOB / EXW / CIF
  notes: text("notes"),
  // Invoicer fields (added by 0007)
  hsCode: text("hs_code"),
  ctnQty: integer("ctn_qty"),
  ctnWeightGrossKg: real("ctn_weight_gross_kg"),
  ctnDimLCm: real("ctn_dim_l_cm"),
  ctnDimWCm: real("ctn_dim_w_cm"),
  ctnDimHCm: real("ctn_dim_h_cm"),
  unitNetWeightG: real("unit_net_weight_g"),
  countryOfOrigin: text("country_of_origin"),
  descriptionRu: text("description_ru"),
  descriptionEn: text("description_en"),
  descriptionCn: text("description_cn"),
  // Packaging facility (added by 0009) — distinct from manufacturer_id which is the legal seller.
  packagingManufacturerId: text("packaging_manufacturer_id").references(() => manufacturers.id),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  deletedAt: integer("deleted_at"),
}, (t) => ({
  mfrIdx: index("idx_products_manufacturer").on(t.manufacturerId),
  catIdx: index("idx_products_category").on(t.category),
  packagingMfrIdx: index("idx_products_packaging_mfr").on(t.packagingManufacturerId),
}));

// =============================================================================
// PRODUCT_PRICES — junction таблица: SKU × PriceType → цена
// =============================================================================
export const productPrices = sqliteTable("product_prices", {
  id: text("id").primaryKey(),
  productId: text("product_id").notNull().references(() => products.id),
  priceTypeId: text("price_type_id").notNull().references(() => priceTypes.id),
  sellPrice: integer("sell_price").notNull(),  // в копейках/центах
  currency: text("currency").notNull(),
  effectiveFrom: integer("effective_from").notNull(),
  effectiveUntil: integer("effective_until"),
  notes: text("notes"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => ({
  prodIdx: index("idx_prices_product").on(t.productId),
  typeIdx: index("idx_prices_type").on(t.priceTypeId),
}));

// =============================================================================
// PARTNERS — контрагенты (buyers, distributors, shippers)
// =============================================================================
// preferred_invoice_language CHECK (in 0007): EN / RU / BILINGUAL / NULL
export const partners = sqliteTable("partners", {
  id: text("id").primaryKey(),
  tradeName: text("trade_name").notNull(),
  legalName: text("legal_name"),
  country: text("country"),
  taxId: text("tax_id"),
  iban: text("iban"),
  swiftBic: text("swift_bic"),
  bankName: text("bank_name"),
  linkedEntityId: text("linked_entity_id").references(() => companies.id),
  priceTypeId: text("price_type_id").references(() => priceTypes.id),
  currency: text("currency"),
  contractNo: text("contract_no"),
  contractDate: integer("contract_date"),
  email: text("email"),
  status: text("status").notNull().default("active"),
  partnerType: text("partner_type").notNull(),  // buyer / supplier / shipper
  notes: text("notes"),
  // Invoicer fields (added by 0007)
  legalNameLocal: text("legal_name_local"),
  registeredAddressLocal: text("registered_address_local"),
  kpp: text("kpp"),
  inn: text("inn"),
  ogrn: text("ogrn"),
  paymentTerms: text("payment_terms"),
  preferredIncoterms: text("preferred_incoterms"),
  preferredInvoiceLanguage: text("preferred_invoice_language"),
  lastVerified: integer("last_verified"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  deletedAt: integer("deleted_at"),
}, (t) => ({
  entIdx: index("idx_partners_entity").on(t.linkedEntityId),
  typeIdx: index("idx_partners_type").on(t.partnerType),
  statusIdx: index("idx_partners_status").on(t.status),
}));

// =============================================================================
// WAREHOUSES — склады (LBR, JEB, HAN, GZH-BW, YZH, etc.)
// =============================================================================
export const warehouses = sqliteTable("warehouses", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  country: text("country"),
  city: text("city"),
  warehouseType: text("warehouse_type"),  // internal / external / bonded / factory / 3pl
  ownerId: text("owner_id").references(() => partners.id),
  notes: text("notes"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  deletedAt: integer("deleted_at"),
});

// =============================================================================
// SHIPPERS — логисты (Inter-Freight, Trans Imperial, etc.)
// =============================================================================
export const shippers = sqliteTable("shippers", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  tradeName: text("trade_name").notNull(),
  legalName: text("legal_name"),
  country: text("country"),
  modes: text("modes"),  // rail / sea / air / multimodal — JSON array
  status: text("status").notNull().default("active"),
  lastVerified: integer("last_verified"),
  notes: text("notes"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  deletedAt: integer("deleted_at"),
});

// =============================================================================
// STOCKS — остатки SKU × Warehouse
// =============================================================================
export const stocks = sqliteTable("stocks", {
  id: text("id").primaryKey(),
  warehouseId: text("warehouse_id").notNull().references(() => warehouses.id),
  productId: text("product_id").notNull().references(() => products.id),
  qtyUnits: integer("qty_units").notNull().default(0),
  notes: text("notes"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => ({
  whIdx: index("idx_stocks_warehouse").on(t.warehouseId),
  prodIdx: index("idx_stocks_product").on(t.productId),
}));

// =============================================================================
// OPERATIONS — Sale / Purchase / Transfer
// =============================================================================
// status CHECK: draft / order_fulfilment / production / shipped / delivered / cancelled
// default_document_language CHECK (in 0007): EN / RU / BILINGUAL / NULL
//   (paid / paid_amount / payment_status were dropped by 0006_payments_and_cleanup;
//    payments now live in their own table.)
export const operations = sqliteTable("operations", {
  id: text("id").primaryKey(),
  operationDate: integer("operation_date").notNull(),
  operationType: text("operation_type").notNull(),  // sale / purchase / transfer
  partnerId: text("partner_id").references(() => partners.id),
  ourCompanyId: text("our_company_id").notNull().references(() => companies.id),
  manufacturerId: text("manufacturer_id").references(() => manufacturers.id),
  warehouseFromId: text("warehouse_from_id").references(() => warehouses.id),
  warehouseToId: text("warehouse_to_id").references(() => warehouses.id),
  shipmentScheme: text("shipment_scheme"),  // A / B / C
  shipperId: text("shipper_id").references(() => partners.id),
  orderDocRef: text("order_doc_ref"),
  status: text("status").notNull().default("draft"),
  priceTypeId: text("price_type_id").references(() => priceTypes.id),
  currency: text("currency"),
  fxRateToUsd: integer("fx_rate_to_usd"),
  totalAmount: integer("total_amount"),
  totalUsdEquiv: integer("total_usd_equiv"),
  incoterms: text("incoterms"),
  hsCode: text("hs_code"),
  leadTimeDays: integer("lead_time_days"),
  notes: text("notes"),
  reference: text("reference"),
  contractId: text("contract_id"),
  defaultDocumentLanguage: text("default_document_language"),
  // Invoicer routing flags (added by 0009)
  deiLayer: integer("dei_layer").notNull().default(0),
  legalSellerId: text("legal_seller_id").references(() => manufacturers.id),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  deletedAt: integer("deleted_at"),
}, (t) => ({
  dateIdx: index("idx_operations_date").on(t.operationDate),
  typeIdx: index("idx_operations_type").on(t.operationType),
  statusIdx: index("idx_operations_status").on(t.status),
  partnerIdx: index("idx_operations_partner").on(t.partnerId),
  referenceIdx: index("idx_operations_reference").on(t.reference),
  contractIdx: index("idx_operations_contract").on(t.contractId),
}));

// =============================================================================
// LINE_ITEMS — позиции внутри Operation
// =============================================================================
export const lineItems = sqliteTable("line_items", {
  id: text("id").primaryKey(),
  operationId: text("operation_id").notNull().references(() => operations.id),
  productId: text("product_id").notNull().references(() => products.id),
  itemDescription: text("item_description"),
  qty: integer("qty").notNull(),
  cartons: integer("cartons").notNull().default(0),  // CTN (целое, ceil)
  innerBoxes: integer("inner_boxes").notNull().default(0),
  unitPrice: integer("unit_price").notNull(),  // в копейках/центах
  discountPct: integer("discount_pct").notNull().default(0),  // 0-100
  unitPriceAfterDisc: integer("unit_price_after_disc").notNull(),
  lineAmount: integer("line_amount").notNull(),
  currency: text("currency").notNull(),
  lineUsdEquiv: integer("line_usd_equiv"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => ({
  opIdx: index("idx_line_items_operation").on(t.operationId),
  prodIdx: index("idx_line_items_product").on(t.productId),
}));

// =============================================================================
// DOCUMENTS — реестр CI / PL / контрактов
// =============================================================================
export const documents = sqliteTable("documents", {
  id: text("id").primaryKey(),
  documentNumber: text("document_number").notNull().unique(),
  documentType: text("document_type").notNull(),  // CI / PL / contract / annex / IS
  operationId: text("operation_id").references(() => operations.id),
  issuerId: text("issuer_id").notNull().references(() => companies.id),
  partnerId: text("partner_id").references(() => partners.id),
  contractRef: text("contract_ref"),
  documentDate: integer("document_date").notNull(),
  currency: text("currency"),
  totalAmount: integer("total_amount"),  // в копейках/центах
  pdfR2Url: text("pdf_r2_url"),
  ownerName: text("owner_name"),  // кто генерирует — Honghui/Jinxia/Я через invoicer
  mandatoryLevel: text("mandatory_level"),  // mandatory / important / on_request
  whenReady: text("when_ready"),
  status: text("status").notNull().default("draft"),
  metadata: text("metadata"),  // JSON для произвольных полей
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  deletedAt: integer("deleted_at"),
}, (t) => ({
  opIdx: index("idx_documents_operation").on(t.operationId),
  typeIdx: index("idx_documents_type").on(t.documentType),
  numIdx: index("idx_documents_number").on(t.documentNumber),
}));

// =============================================================================
// INVENTORY_SESSIONS — сессии инвентаризации
// =============================================================================
export const inventorySessions = sqliteTable("inventory_sessions", {
  id: text("id").primaryKey(),
  warehouseId: text("warehouse_id").notNull().references(() => warehouses.id),
  inventoryDate: integer("inventory_date").notNull(),
  status: text("status").notNull().default("active"),  // active / applied / cancelled
  notes: text("notes"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// =============================================================================
// INVENTORY_ITEMS — позиции в сессии инвентаризации
// =============================================================================
export const inventoryItems = sqliteTable("inventory_items", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => inventorySessions.id),
  productId: text("product_id").notNull().references(() => products.id),
  expectedQty: integer("expected_qty").notNull(),
  countedQty: integer("counted_qty"),
  deltaQty: integer("delta_qty"),
  notes: text("notes"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => ({
  sessIdx: index("idx_inventory_items_session").on(t.sessionId),
}));

// =============================================================================
// SEQUENCES — счётчики для генерации DEI-001, CI-202605-0001 и т.д.
// =============================================================================
export const sequences = sqliteTable("sequences", {
  id: text("id").primaryKey(),
  description: text("description"),
  nextNumber: integer("next_number").notNull().default(1),
  padding: integer("padding").notNull().default(3),
  formatExample: text("format_example"),
  updatedAt: integer("updated_at").notNull(),
});

// =============================================================================
// FX_RATES — курсы валют по дням
// =============================================================================
export const fxRates = sqliteTable("fx_rates", {
  id: text("id").primaryKey(),
  rateDate: integer("rate_date").notNull(),
  fromCurrency: text("from_currency").notNull(),
  toCurrency: text("to_currency").notNull(),
  rate: integer("rate").notNull(),  // × 1,000,000 для precision
  source: text("source"),  // CBR / ECB / manual
  createdAt: integer("created_at").notNull(),
}, (t) => ({
  dateIdx: index("idx_fx_rates_date").on(t.rateDate),
  pairIdx: index("idx_fx_rates_pair").on(t.fromCurrency, t.toCurrency),
}));
