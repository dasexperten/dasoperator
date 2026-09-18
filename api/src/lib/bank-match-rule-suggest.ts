// =============================================================================
// Bank match rule SUGGESTION — the only model-backed part of bank matching.
// Split from bank-match-rules.ts so the nightly matcher (erp-bank-match) carries
// no model client. Called after a manual /attach in /api/inbox/banking.
// =============================================================================

import type { Env } from '../types';
import { callPro } from './llm';
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
      { env, maxTokens: 400, temperature: 0.3, prefer: 'openrouter' },
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

