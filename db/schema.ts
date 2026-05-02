import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

// =============================================================================
// COMPANIES — наши юрлица (DEE, DEI, DEASEAN, DEC)
// =============================================================================
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
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  deletedAt: integer("deleted_at"),
}, (t) => ({
  abbrIdx: index("idx_companies_abbreviation").on(t.abbreviation),
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
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  deletedAt: integer("deleted_at"),
});

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
export const products = sqliteTable("products", {
  id: text("id").primaryKey(),                  // SKU как ID (DE201, DE105, etc.)
  productName: text("product_name").notNull(),
  invoiceLabel: text("invoice_label").notNull(),
  category: text("category").notNull(),         // Toothpaste / Toothbrush
  barcode: text("barcode"),
  weightKg: integer("weight_kg"),               // в граммах (умн. на 1000)
  volumeM3Micro: integer("volume_m3_micro"),    // в микролитрах × 1000 (для precision)
  manufacturerId: text("manufacturer_id").notNull().references(() => manufacturers.id),
  buyPrice: integer("buy_price"),               // в копейках/центах
  buyCurrency: text("buy_currency"),
  buyTerm: text("buy_term"),                    // FOB / EXW / CIF
  notes: text("notes"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  deletedAt: integer("deleted_at"),
}, (t) => ({
  mfrIdx: index("idx_products_manufacturer").on(t.manufacturerId),
  catIdx: index("idx_products_category").on(t.category),
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
  paid: integer("paid").notNull().default(0),
  priceTypeId: text("price_type_id").references(() => priceTypes.id),
  currency: text("currency"),
  fxRateToUsd: integer("fx_rate_to_usd"),  // в микро-единицах × 1,000,000
  totalAmount: integer("total_amount"),    // в копейках/центах
  totalUsdEquiv: integer("total_usd_equiv"),
  incoterms: text("incoterms"),
  hsCode: text("hs_code"),
  leadTimeDays: integer("lead_time_days"),
  notes: text("notes"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  deletedAt: integer("deleted_at"),
}, (t) => ({
  dateIdx: index("idx_operations_date").on(t.operationDate),
  typeIdx: index("idx_operations_type").on(t.operationType),
  statusIdx: index("idx_operations_status").on(t.status),
  partnerIdx: index("idx_operations_partner").on(t.partnerId),
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
