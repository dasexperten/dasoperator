-- =============================================================================
-- Migration 0041 — Agent Settlements (triangle settlement model)
-- =============================================================================
--
-- Models the triangle settlement pattern for paying intra-group debt via agents.
--
-- Example scenario:
--   Yangzhou Jinxia → DEI → DEE  (goods flow; DEE owes DEI in USD)
--   DEE pays N CNY to Bright Ideas Trading (agent)
--   Centuno Co. Ltd pays equivalent USD to DEI (paired agent)
--   DEI books a paper invoice to Centuno (adjusted to match Centuno's payment)
--   Net effect: DEE→DEI debt cleared without direct cross-border transfer.
--
-- Each settlement record glues together:
--   - One OUTBOUND bank_transaction (own entity → agent)
--   - One INBOUND bank_transaction (paired agent → own entity)
--   - Optional clearance operation (the intra-group debt being settled)
--   - Optional paper invoice document (the fake DEI→Centuno invoice)
--
-- One leg may arrive before the other; status='pending_match' until both present.
-- =============================================================================

CREATE TABLE agent_settlements (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL,

  settlement_date INTEGER NOT NULL,

  -- Outbound leg (own entity pays agent)
  outbound_bank_tx_id TEXT,
  outbound_amount REAL NOT NULL,
  outbound_currency TEXT NOT NULL,
  outbound_company_id TEXT NOT NULL,
  outbound_agent_partner_id TEXT NOT NULL,

  -- Inbound leg (paired agent pays own entity)
  inbound_bank_tx_id TEXT,
  inbound_amount REAL NOT NULL,
  inbound_currency TEXT NOT NULL,
  inbound_company_id TEXT NOT NULL,
  inbound_agent_partner_id TEXT NOT NULL,

  -- Intra-group debt being cleared
  clearance_operation_id TEXT,
  clearance_creditor_company_id TEXT,
  clearance_debtor_company_id TEXT,

  -- Paper trail (fake invoice from creditor entity to paired agent)
  paper_invoice_document_id TEXT,

  -- Reconciliation
  exchange_rate REAL,
  variance_amount REAL,
  variance_currency TEXT,

  status TEXT NOT NULL DEFAULT 'pending_match',
  notes TEXT,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,

  CHECK (status IN ('draft', 'pending_match', 'settled', 'cancelled')),
  FOREIGN KEY (outbound_bank_tx_id)         REFERENCES bank_transactions(id) ON DELETE SET NULL,
  FOREIGN KEY (inbound_bank_tx_id)          REFERENCES bank_transactions(id) ON DELETE SET NULL,
  FOREIGN KEY (outbound_company_id)         REFERENCES companies(id),
  FOREIGN KEY (inbound_company_id)          REFERENCES companies(id),
  FOREIGN KEY (outbound_agent_partner_id)   REFERENCES partners(id),
  FOREIGN KEY (inbound_agent_partner_id)    REFERENCES partners(id),
  FOREIGN KEY (clearance_operation_id)      REFERENCES operations(id) ON DELETE SET NULL,
  FOREIGN KEY (clearance_creditor_company_id) REFERENCES companies(id),
  FOREIGN KEY (clearance_debtor_company_id)   REFERENCES companies(id),
  FOREIGN KEY (paper_invoice_document_id)   REFERENCES documents(id) ON DELETE SET NULL
);

CREATE INDEX idx_agent_settlements_status        ON agent_settlements(status, deleted_at);
CREATE INDEX idx_agent_settlements_outbound_tx   ON agent_settlements(outbound_bank_tx_id);
CREATE INDEX idx_agent_settlements_inbound_tx    ON agent_settlements(inbound_bank_tx_id);
CREATE INDEX idx_agent_settlements_clearance_op  ON agent_settlements(clearance_operation_id);
CREATE INDEX idx_agent_settlements_date          ON agent_settlements(settlement_date DESC);
CREATE INDEX idx_agent_settlements_companies     ON agent_settlements(outbound_company_id, inbound_company_id);

-- Unique reference per active record
CREATE UNIQUE INDEX idx_agent_settlements_reference_active
  ON agent_settlements(reference)
  WHERE deleted_at IS NULL;
