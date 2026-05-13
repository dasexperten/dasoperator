// =============================================================================
// Transaction classifier — pure SQL cascade (L1 rules + L2 memory)
// =============================================================================
//
// Called from autoMatchBankTransaction BEFORE the heuristic cascade.
//
// Decision flow:
//   L1: rules table — match by (counterparty INN/IBAN, purpose substring,
//                              direction)
//   L2: counterparty memory — if same partner was N-times assigned to the
//                              same category, suggest it
//   L3: nothing matched → goes to Inbox unsuggested
//
// Output shape: { category_id, confidence, source, reason }
//   confidence is 0..1
//   source = 'rule_inn_pattern' | 'rule_inn_only' | 'rule_iban' |
//            'rule_purpose_only' | 'memory_consensus' | null
// =============================================================================

import type { Env } from '../types';
import type { BankMatchRule } from './bank-match-rules';

export interface ClassificationResult {
  category_id: string | null;
  confidence: number;            // 0.0 to 1.0
  source: ClassificationSource;
  reason: string;
  matched_rule_id?: string;
  // Suggested values resolved from category + rule
  default_operation_type?: 'sale' | 'purchase' | 'transfer' | 'bundling';
  partner_id?: string | null;
  always_confirm?: boolean;
}

export type ClassificationSource =
  | 'rule_inn_pattern'      // 0.95
  | 'rule_inn_only'         // 0.85
  | 'rule_iban'             // 0.90
  | 'rule_purpose_only'     // 0.70
  | 'memory_consensus'      // 0.80 if 3+ same; 0.60 if 2
  | null;

const CONFIDENCE = {
  rule_inn_pattern: 0.95,
  rule_inn_only: 0.85,
  rule_iban: 0.90,
  rule_purpose_only: 0.70,
  memory_strong: 0.85,    // 3+ same
  memory_weak: 0.65,      // 2 same
};

// High-confidence threshold for auto-classification.
// Below this AND/OR if category.always_confirm = 1 → goes to Inbox.
export const AUTO_CLASSIFY_THRESHOLD = 0.80;
export const MEMORY_STRONG_THRESHOLD = 3;
export const MEMORY_WEAK_THRESHOLD = 2;

interface TxInput {
  contragent_inn: string | null;
  contragent_account: string | null;  // IBAN for non-RU
  contragent_name: string | null;
  payment_purpose: string | null;
  direction: 'incoming' | 'outgoing';
}

// =============================================================================
// Main entry — classify a transaction
// =============================================================================
export async function classifyTransaction(
  env: Env,
  tx: TxInput
): Promise<ClassificationResult> {
  // L1.1 — rule by INN + purpose pattern
  let r = await tryRuleInnPattern(env, tx);
  if (r) return r;

  // L1.2 — rule by IBAN (for foreign counterparties)
  r = await tryRuleIban(env, tx);
  if (r) return r;

  // L1.3 — rule by INN only
  r = await tryRuleInnOnly(env, tx);
  if (r) return r;

  // L1.4 — rule by purpose only (generic patterns like "bank fee")
  r = await tryRulePurposeOnly(env, tx);
  if (r) return r;

  // L2 — counterparty memory
  r = await tryCounterpartyMemory(env, tx);
  if (r) return r;

  // L3 — nothing matched
  return {
    category_id: null,
    confidence: 0,
    source: null,
    reason: 'No rule or counterparty memory matched',
  };
}

// =============================================================================
// L1.1 — rule with INN + purpose pattern
// =============================================================================
async function tryRuleInnPattern(env: Env, tx: TxInput): Promise<ClassificationResult | null> {
  const inn = (tx.contragent_inn || '').trim();
  const purpose = (tx.payment_purpose || '').toLowerCase();
  if (!inn || !purpose) return null;

  const rules = await env.DB.prepare(
    `SELECT r.id, r.category_id, r.partner_id, r.purpose_pattern,
            r.default_operation_type, r.contragent_inn,
            c.always_confirm
       FROM bank_match_rules r
       LEFT JOIN finance_categories c ON c.id = r.category_id
      WHERE r.contragent_inn = ?
        AND r.purpose_pattern IS NOT NULL
        AND r.deleted_at IS NULL
        AND (r.direction = ? OR r.direction = 'any')
      ORDER BY r.hit_count DESC`
  ).bind(inn, tx.direction).all<any>();

  for (const rule of rules.results ?? []) {
    const pat = (rule.purpose_pattern || '').toLowerCase().trim();
    if (pat && purpose.includes(pat)) {
      return {
        category_id: rule.category_id,
        confidence: CONFIDENCE.rule_inn_pattern,
        source: 'rule_inn_pattern',
        reason: `Rule matched: INN ${inn} + pattern "${pat}"`,
        matched_rule_id: rule.id,
        default_operation_type: rule.default_operation_type,
        partner_id: rule.partner_id,
        always_confirm: rule.always_confirm === 1,
      };
    }
  }
  return null;
}

// =============================================================================
// L1.2 — rule by IBAN
// =============================================================================
async function tryRuleIban(env: Env, tx: TxInput): Promise<ClassificationResult | null> {
  const iban = (tx.contragent_account || '').replace(/\s+/g, '').toUpperCase();
  if (!iban || iban.length < 8) return null;

  const rule = await env.DB.prepare(
    `SELECT r.id, r.category_id, r.partner_id, r.default_operation_type, c.always_confirm
       FROM bank_match_rules r
       LEFT JOIN finance_categories c ON c.id = r.category_id
      WHERE REPLACE(UPPER(r.contragent_iban), ' ', '') = ?
        AND r.deleted_at IS NULL
        AND (r.direction = ? OR r.direction = 'any')
      ORDER BY r.hit_count DESC
      LIMIT 1`
  ).bind(iban, tx.direction).first<any>();

  if (!rule) return null;
  return {
    category_id: rule.category_id,
    confidence: CONFIDENCE.rule_iban,
    source: 'rule_iban',
    reason: `Rule matched: IBAN ${iban}`,
    matched_rule_id: rule.id,
    default_operation_type: rule.default_operation_type,
    partner_id: rule.partner_id,
    always_confirm: rule.always_confirm === 1,
  };
}

// =============================================================================
// L1.3 — rule by INN only (no pattern, no IBAN)
// =============================================================================
async function tryRuleInnOnly(env: Env, tx: TxInput): Promise<ClassificationResult | null> {
  const inn = (tx.contragent_inn || '').trim();
  if (!inn) return null;

  const rule = await env.DB.prepare(
    `SELECT r.id, r.category_id, r.partner_id, r.default_operation_type, c.always_confirm
       FROM bank_match_rules r
       LEFT JOIN finance_categories c ON c.id = r.category_id
      WHERE r.contragent_inn = ?
        AND r.purpose_pattern IS NULL
        AND r.contragent_iban IS NULL
        AND r.deleted_at IS NULL
        AND (r.direction = ? OR r.direction = 'any')
      ORDER BY r.hit_count DESC
      LIMIT 1`
  ).bind(inn, tx.direction).first<any>();

  if (!rule) return null;
  return {
    category_id: rule.category_id,
    confidence: CONFIDENCE.rule_inn_only,
    source: 'rule_inn_only',
    reason: `Rule matched: INN ${inn}`,
    matched_rule_id: rule.id,
    default_operation_type: rule.default_operation_type,
    partner_id: rule.partner_id,
    always_confirm: rule.always_confirm === 1,
  };
}

// =============================================================================
// L1.4 — rule by purpose substring only (generic patterns)
// =============================================================================
async function tryRulePurposeOnly(env: Env, tx: TxInput): Promise<ClassificationResult | null> {
  const purpose = (tx.payment_purpose || '').toLowerCase();
  if (!purpose) return null;

  const rules = await env.DB.prepare(
    `SELECT r.id, r.category_id, r.partner_id, r.purpose_pattern, r.default_operation_type, c.always_confirm
       FROM bank_match_rules r
       LEFT JOIN finance_categories c ON c.id = r.category_id
      WHERE r.contragent_inn IS NULL
        AND r.contragent_iban IS NULL
        AND r.purpose_pattern IS NOT NULL
        AND r.deleted_at IS NULL
        AND (r.direction = ? OR r.direction = 'any')
      ORDER BY r.hit_count DESC`
  ).bind(tx.direction).all<any>();

  for (const rule of rules.results ?? []) {
    const pat = (rule.purpose_pattern || '').toLowerCase().trim();
    if (pat && purpose.includes(pat)) {
      return {
        category_id: rule.category_id,
        confidence: CONFIDENCE.rule_purpose_only,
        source: 'rule_purpose_only',
        reason: `Generic rule matched: pattern "${pat}"`,
        matched_rule_id: rule.id,
        default_operation_type: rule.default_operation_type,
        partner_id: rule.partner_id,
        always_confirm: rule.always_confirm === 1,
      };
    }
  }
  return null;
}

// =============================================================================
// L2 — counterparty memory (look at last N assigned tx of same partner)
// =============================================================================
async function tryCounterpartyMemory(env: Env, tx: TxInput): Promise<ClassificationResult | null> {
  const inn = (tx.contragent_inn || '').trim();
  if (!inn) return null;

  // Find last 5 manually-resolved txs of this INN
  // We look at suggested_category_id of confirmed past txs (proxy via operation type
  // of the matched operation — if all matched operations of this partner are of same
  // type, we infer category from that).
  //
  // Simpler: count tx with same INN + same category_id (after they were resolved
  // through Inbox), pick winner if >= MEMORY_WEAK_THRESHOLD.

  const rows = await env.DB.prepare(
    `SELECT suggested_category_id AS cat, COUNT(*) AS cnt
       FROM bank_transactions
      WHERE contragent_inn = ?
        AND direction = ?
        AND suggested_category_id IS NOT NULL
        AND matched_payment_id IS NOT NULL
        AND deleted_at IS NULL
      GROUP BY suggested_category_id
      ORDER BY cnt DESC
      LIMIT 3`
  ).bind(inn, tx.direction).all<{ cat: string; cnt: number }>();

  const top = rows.results?.[0];
  if (!top || top.cnt < MEMORY_WEAK_THRESHOLD) return null;

  // If the top category has 2x more hits than second, OR has >= MEMORY_STRONG_THRESHOLD,
  // mark strong; else weak.
  const second = rows.results?.[1];
  const isStrong = top.cnt >= MEMORY_STRONG_THRESHOLD || (second && top.cnt >= second.cnt * 2);
  const confidence = isStrong ? CONFIDENCE.memory_strong : CONFIDENCE.memory_weak;

  // Get category defaults
  const cat = await env.DB.prepare(
    `SELECT id, default_operation_type, always_confirm FROM finance_categories
      WHERE id = ? AND deleted_at IS NULL`
  ).bind(top.cat).first<any>();
  if (!cat) return null;

  return {
    category_id: top.cat,
    confidence,
    source: 'memory_consensus',
    reason: `Counterparty memory: INN ${inn} → this category ${top.cnt}/${(rows.results || []).reduce((s, r) => s + r.cnt, 0)} times`,
    default_operation_type: cat.default_operation_type,
    always_confirm: cat.always_confirm === 1,
  };
}

// =============================================================================
// Apply classification — decide if auto-attach or send to Inbox
// =============================================================================
export interface ClassifyDecision {
  action: 'auto_classify' | 'inbox_suggest' | 'inbox_blank';
  category_id: string | null;
  confidence: number;
  source: ClassificationSource;
  reason: string;
  matched_rule_id?: string;
  default_operation_type?: 'sale' | 'purchase' | 'transfer' | 'bundling';
  partner_id?: string | null;
}

export function decideAction(result: ClassificationResult): ClassifyDecision {
  // L3 — nothing matched
  if (!result.category_id || result.confidence === 0) {
    return {
      action: 'inbox_blank',
      category_id: null,
      confidence: 0,
      source: null,
      reason: result.reason,
    };
  }

  // Always-confirm category → suggest only, never auto
  if (result.always_confirm) {
    return {
      action: 'inbox_suggest',
      category_id: result.category_id,
      confidence: result.confidence,
      source: result.source,
      reason: `${result.reason} (category marked always-confirm)`,
      matched_rule_id: result.matched_rule_id,
      default_operation_type: result.default_operation_type,
      partner_id: result.partner_id,
    };
  }

  // High confidence → auto
  if (result.confidence >= AUTO_CLASSIFY_THRESHOLD) {
    return {
      action: 'auto_classify',
      category_id: result.category_id,
      confidence: result.confidence,
      source: result.source,
      reason: result.reason,
      matched_rule_id: result.matched_rule_id,
      default_operation_type: result.default_operation_type,
      partner_id: result.partner_id,
    };
  }

  // Low confidence → suggest in Inbox
  return {
    action: 'inbox_suggest',
    category_id: result.category_id,
    confidence: result.confidence,
    source: result.source,
    reason: result.reason,
    matched_rule_id: result.matched_rule_id,
    default_operation_type: result.default_operation_type,
    partner_id: result.partner_id,
  };
}

// =============================================================================
// Persist suggestion onto bank_transaction row (used when action is 'inbox_suggest')
// =============================================================================
export async function persistSuggestion(
  env: Env,
  txId: string,
  decision: ClassifyDecision
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `UPDATE bank_transactions
        SET suggested_category_id = ?, suggested_confidence = ?, suggested_reason = ?,
            updated_at = ?
      WHERE id = ?`
  ).bind(
    decision.category_id,
    decision.confidence,
    decision.reason,
    now,
    txId
  ).run();
}
