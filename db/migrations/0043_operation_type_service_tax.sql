-- Migration 0043: расширить operation_type CHECK + переклассифицировать
-- BEFORE: ('sale','purchase','transfer','bundling')
-- AFTER:  ('sale','purchase','transfer','service','tax')
-- bundling больше не самостоятельный тип:
--   - внутренний bundling → transfer (внутренняя комплектация)
--   - F4-провайдер bundling → service (внешняя услуга комплектации)
-- Существующие 330 purchase → распределяются:
--   - ФНС (fns), ФТС (fts) → tax
--   - все остальные service_provider партнёры → service
--   - реальные товарные закупки (manufacturer, 3pl, etc.) → остаются purchase
-- =============================================================================

-- Step 1: создаём новую таблицу с расширенным CHECK
CREATE TABLE "operations_new" (
  id TEXT PRIMARY KEY,
  operation_date INTEGER NOT NULL,
  operation_type TEXT NOT NULL CHECK (operation_type IN ('sale','purchase','transfer','service','tax')),
  partner_id TEXT,
  our_company_id TEXT NOT NULL,
  manufacturer_id TEXT,
  warehouse_from_id TEXT,
  warehouse_to_id TEXT,
  shipment_scheme TEXT CHECK (shipment_scheme IN ('A','B','C') OR shipment_scheme IS NULL),
  shipper_id TEXT,
  order_doc_ref TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','order_fulfilment','production','stocked','shipped','delivered','cancelled')),
  price_type_id TEXT,
  currency TEXT,
  fx_rate_to_usd INTEGER,
  total_amount INTEGER,
  total_usd_equiv INTEGER,
  incoterms TEXT,
  hs_code TEXT,
  lead_time_days INTEGER,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  reference TEXT,
  contract_id TEXT REFERENCES "contracts"(id),
  default_document_language TEXT CHECK (default_document_language IN ('EN','RU','BILINGUAL') OR default_document_language IS NULL),
  dei_layer INTEGER NOT NULL DEFAULT 0 CHECK (dei_layer IN (0,1)),
  legal_seller_id TEXT REFERENCES manufacturers(id),
  vat_rate INTEGER NOT NULL DEFAULT 0 CHECK (vat_rate IN (0,5,20)),
  receiving_company_id TEXT REFERENCES companies(id) ON DELETE RESTRICT,
  via_dei INTEGER NOT NULL DEFAULT 0 CHECK (via_dei IN (0,1)),
  delivery_status TEXT NOT NULL DEFAULT 'delivered' CHECK (delivery_status IN ('pending','delivered','disputed','refunded')),
  operation_track TEXT NOT NULL DEFAULT 'goods' CHECK (operation_track IN ('goods','service')),
  arrival_detected_at INTEGER,
  arrival_source_request_id TEXT,
  arrival_received_qtys TEXT,
  arrival_rejected_at INTEGER,
  gtd_number TEXT,
  issuing_partner_id TEXT,
  issuing_bank_account_id TEXT,
  batch_id TEXT REFERENCES operation_batches(id) ON DELETE SET NULL,
  FOREIGN KEY (partner_id) REFERENCES partners(id) ON DELETE RESTRICT,
  FOREIGN KEY (our_company_id) REFERENCES companies(id) ON DELETE RESTRICT,
  FOREIGN KEY (manufacturer_id) REFERENCES manufacturers(id) ON DELETE RESTRICT,
  FOREIGN KEY (warehouse_from_id) REFERENCES warehouses(id) ON DELETE RESTRICT,
  FOREIGN KEY (warehouse_to_id) REFERENCES warehouses(id) ON DELETE RESTRICT,
  FOREIGN KEY (shipper_id) REFERENCES partners(id) ON DELETE RESTRICT,
  FOREIGN KEY (price_type_id) REFERENCES price_types(id) ON DELETE RESTRICT
);

-- Step 2: копируем строки с переклассификацией operation_type
INSERT INTO operations_new
SELECT
  o.id,
  o.operation_date,
  CASE
    -- ФНС, ФТС → tax
    WHEN o.partner_id IN ('fns','fts') THEN 'tax'
    -- bundling (был отдельным типом) → transfer (внутренний) или service (F4 как провайдер)
    WHEN o.operation_type = 'bundling' AND o.partner_id = 'f4_lubertsy' THEN 'service'
    WHEN o.operation_type = 'bundling' THEN 'transfer'
    -- purchase, у которого партнёр service_provider → service
    WHEN o.operation_type = 'purchase' AND EXISTS (
      SELECT 1 FROM partners p WHERE p.id = o.partner_id AND p.kind = 'service_provider'
    ) THEN 'service'
    -- всё прочее остаётся как было
    ELSE o.operation_type
  END as operation_type,
  o.partner_id,
  o.our_company_id,
  o.manufacturer_id,
  o.warehouse_from_id,
  o.warehouse_to_id,
  o.shipment_scheme,
  o.shipper_id,
  o.order_doc_ref,
  o.status,
  o.price_type_id,
  o.currency,
  o.fx_rate_to_usd,
  o.total_amount,
  o.total_usd_equiv,
  o.incoterms,
  o.hs_code,
  o.lead_time_days,
  o.notes,
  o.created_at,
  o.updated_at,
  o.deleted_at,
  o.reference,
  o.contract_id,
  o.default_document_language,
  o.dei_layer,
  o.legal_seller_id,
  o.vat_rate,
  o.receiving_company_id,
  o.via_dei,
  o.delivery_status,
  o.operation_track,
  o.arrival_detected_at,
  o.arrival_source_request_id,
  o.arrival_received_qtys,
  o.arrival_rejected_at,
  o.gtd_number,
  o.issuing_partner_id,
  o.issuing_bank_account_id,
  o.batch_id
FROM operations o;

-- Step 3: drop old, rename new
DROP TABLE operations;
ALTER TABLE operations_new RENAME TO operations;

-- Step 4: recreate indexes
CREATE INDEX idx_operations_partner ON operations(partner_id);
CREATE INDEX idx_operations_contract ON operations(contract_id);
CREATE INDEX idx_operations_status ON operations(status);
CREATE INDEX idx_operations_type ON operations(operation_type);
CREATE INDEX idx_operations_date ON operations(operation_date);
CREATE INDEX idx_operations_company ON operations(our_company_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_operations_track ON operations(operation_track);
CREATE INDEX idx_operations_batch_id ON operations(batch_id);
