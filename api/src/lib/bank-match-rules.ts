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
import { callPro } from './llm';

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
// suggestRuleFromAssignment — Claude API extracts a substring pattern
// from payment_purpose. Called AFTER manual /attach, off the hot path.
// =============================================================================
export interface RuleSuggestion {
  partner_id: string;
  contragent_inn: string | null;
  purpose_pattern: string | null;
  direction: 'incoming' | 'outgoing';
  default_operation_type: 'sale' | 'purchase' | 'transfer' | 'bundling';
  default_our_company_id: string | null;
  rationale: string;
}

export async function suggestRuleFromAssignment(
  env: Env,
  context: {
    tx: {
      direction: 'incoming' | 'outgoing';
      contragent_name: string | null;
      contragent_inn: string | null;
      payment_purpose: string | null;
      amount: number;
      currency: string;
    };
    operation: {
      id: string;
      reference: string;
      operation_type: string;
      partner_id: string | null;
      our_company_id: string;
    };
    partner: {
      id: string;
      trade_name: string | null;
      kind: string;
    } | null;
  }
): Promise<RuleSuggestion | null> {
  if (!env.CLAUDE_CODE_OAUTH_TOKEN && !env.DEEPSEEK_API_KEY) {
    // Fallback: deterministic rule without LLM
    return fallbackSuggestion(context);
  }

  const prompt = `You are a finance ERP rule extractor. A user manually assigned a bank transaction to an operation. Decide if a reusable rule should be created so future transactions of the same kind auto-match.

TRANSACTION:
  Direction: ${context.tx.direction}
  Counterparty name: ${context.tx.contragent_name || '(none)'}
  Counterparty INN: ${context.tx.contragent_inn || '(none)'}
  Payment purpose: ${context.tx.payment_purpose || '(none)'}
  Amount: ${context.tx.amount / 100} ${context.tx.currency}

USER ASSIGNED IT TO:
  Operation reference: ${context.operation.reference}
  Operation type: ${context.operation.operation_type}
  Partner ID: ${context.operation.partner_id || '(none)'}
  Our company: ${context.operation.our_company_id}

PARTNER:
  Name: ${context.partner?.trade_name || '(none)'}
  Kind: ${context.partner?.kind || '(none)'}

Output strict JSON:
{
  "should_create_rule": true|false,
  "purpose_pattern": "<short distinctive substring (3-40 chars) that will match similar future transactions; or null if pattern is too noisy>",
  "rationale": "<one sentence why or why not>"
}

Rules for pattern selection:
- Strip dates, document numbers, amounts, contract numbers (anything that changes every transaction).
- Keep the action/category words: "Accounting Services", "Logistics", "Rent", "Bank commission", "Эквайринг", "Оплата по договору", etc.
- Pattern must be 3-40 chars, lowercase-comparable substring.
- If purpose is too vague or unique-per-transaction → should_create_rule=false.
- Return ONLY JSON, no markdown fences.`;

  try {
    const result = await callPro(
      [{ role: 'user', content: prompt }],
      { env, maxTokens: 400, temperature: 0.3, prefer: 'anthropic' },
    );

    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return fallbackSuggestion(context);

    const parsed = JSON.parse(jsonMatch[0]) as {
      should_create_rule: boolean;
      purpose_pattern: string | null;
      rationale: string;
    };

    if (!parsed.should_create_rule) return null;

    return {
      partner_id: context.operation.partner_id || context.partner?.id || '',
      contragent_inn: context.tx.contragent_inn,
      purpose_pattern: parsed.purpose_pattern,
      direction: context.tx.direction,
      default_operation_type: context.operation.operation_type as RuleSuggestion['default_operation_type'],
      default_our_company_id: context.operation.our_company_id,
      rationale: parsed.rationale,
    };
  } catch (e) {
    console.error('[rule-suggest] failed', e);
    return fallbackSuggestion(context);
  }
}

// =============================================================================
// Fallback: deterministic suggestion when Claude is unavailable
// =============================================================================
function fallbackSuggestion(context: {
  tx: { direction: 'incoming' | 'outgoing'; contragent_inn: string | null; payment_purpose: string | null };
  operation: { partner_id: string | null; operation_type: string; our_company_id: string };
  partner: { id: string } | null;
}): RuleSuggestion | null {
  const partnerId = context.operation.partner_id || context.partner?.id || '';
  if (!partnerId) return null;

  // Take first 2-3 meaningful words of payment_purpose
  const purpose = (context.tx.payment_purpose || '').trim();
  let pattern: string | null = null;
  if (purpose) {
    // Strip leading dates, numbers
    const cleaned = purpose
      .replace(/\d{1,2}[./-]\d{1,2}[./-]\d{2,4}/g, '')
      .replace(/№\s*\d+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const words = cleaned.split(/\s+/).filter((w) => w.length > 2);
    if (words.length >= 1) {
      pattern = words.slice(0, 3).join(' ').toLowerCase();
      if (pattern.length > 40) pattern = pattern.slice(0, 40);
    }
  }

  return {
    partner_id: partnerId,
    contragent_inn: context.tx.contragent_inn,
    purpose_pattern: pattern,
    direction: context.tx.direction,
    default_operation_type: context.operation.operation_type as RuleSuggestion['default_operation_type'],
    default_our_company_id: context.operation.our_company_id,
    rationale: 'Fallback rule extracted from first words of purpose (Claude unavailable).',
  };
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
