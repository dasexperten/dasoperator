// =============================================================================
// Bank match rules — fast path before LLM/auto-match cascade
// =============================================================================
//
// Flow:
//   1. New bank_transaction arrives
//   2. findMatchingRule(tx) — fast SQL on bank_match_rules (no LLM)
//   3. If rule found → apply (create operation or attach to most recent open
//      operation of that type/partner) and persist outcome
//   4. If no rule → falls through to existing auto-match cascade
//
// After every manual /attach call in /api/inbox/banking, Claude API is called
// to SUGGEST a rule (off the hot path). Suggestion is returned to UI; user
// confirms with one click.
// =============================================================================

import type { Env } from '../types';

export interface BankMatchRule {
  id: string;
  partner_id: string | null;
  contragent_inn: string | null;
  purpose_pattern: string | null;
  direction: 'incoming' | 'outgoing' | 'any';
  default_operation_type: 'sale' | 'purchase' | 'transfer' | 'bundling';
  default_our_company_id: string | null;
  hit_count: number;
  last_hit_at: number | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  notes: string | null;
}

export interface RuleMatch {
  rule: BankMatchRule;
  match_strength: 'inn_and_purpose' | 'inn_only' | 'purpose_only';
}

// =============================================================================
// findMatchingRule — pure SQL, no LLM. Called first in auto-match.
// =============================================================================
export async function findMatchingRule(
  env: Env,
  tx: {
    contragent_inn: string | null;
    payment_purpose: string | null;
    direction: 'incoming' | 'outgoing';
  }
): Promise<RuleMatch | null> {
  const inn = (tx.contragent_inn || '').trim();
  const purpose = (tx.payment_purpose || '').toLowerCase();

  // Step 1: INN-based rules first (strongest signal)
  if (inn) {
    const innRules = await env.DB.prepare(
      `SELECT * FROM bank_match_rules
        WHERE contragent_inn = ? AND deleted_at IS NULL
          AND (direction = ? OR direction = 'any')
        ORDER BY hit_count DESC, created_at DESC`
    ).bind(inn, tx.direction).all<BankMatchRule>();

    for (const rule of innRules.results ?? []) {
      // If rule has purpose_pattern, BOTH must match
      if (rule.purpose_pattern) {
        const pat = rule.purpose_pattern.toLowerCase().trim();
        if (purpose.includes(pat)) {
          return { rule, match_strength: 'inn_and_purpose' };
        }
        continue;
      }
      // INN-only rule
      return { rule, match_strength: 'inn_only' };
    }
  }

  // Step 2: Purpose-only rules (rules with no INN — generic patterns like "bank fee")
  if (purpose) {
    const purposeRules = await env.DB.prepare(
      `SELECT * FROM bank_match_rules
        WHERE contragent_inn IS NULL AND purpose_pattern IS NOT NULL
          AND deleted_at IS NULL
          AND (direction = ? OR direction = 'any')
        ORDER BY hit_count DESC, created_at DESC`
    ).bind(tx.direction).all<BankMatchRule>();

    for (const rule of purposeRules.results ?? []) {
      const pat = (rule.purpose_pattern || '').toLowerCase().trim();
      if (pat && purpose.includes(pat)) {
        return { rule, match_strength: 'purpose_only' };
      }
    }
  }

  return null;
}

// =============================================================================
// recordRuleHit — bump hit_count, last_hit_at after rule is applied
// =============================================================================
export async function recordRuleHit(env: Env, ruleId: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `UPDATE bank_match_rules
        SET hit_count = hit_count + 1, last_hit_at = ?, updated_at = ?
      WHERE id = ?`
  ).bind(now, now, ruleId).run();
}

// =============================================================================
// applyRuleMatch — given a rule + tx, returns the operation_id to attach to.
// If no open operation matches the rule → returns null (caller may create one).
// =============================================================================
export async function findOperationForRule(
  env: Env,
  rule: BankMatchRule,
  tx: { amount: number; currency: string; executed_at: number }
): Promise<{ operation_id: string; reference: string } | null> {
  if (!rule.partner_id) return null;

  // Look for most recent open operation of the same type for this partner
  const op = await env.DB.prepare(
    `SELECT id, reference
       FROM operations
      WHERE partner_id = ?
        AND operation_type = ?
        AND status IN ('draft','issued','order_fulfilment','production','stocked','shipped')
        AND currency = ?
        AND (deleted_at IS NULL OR deleted_at = 0)
      ORDER BY operation_date DESC
      LIMIT 1`
  ).bind(rule.partner_id, rule.default_operation_type, tx.currency).first<{ id: string; reference: string }>();

  return op || null;
}
