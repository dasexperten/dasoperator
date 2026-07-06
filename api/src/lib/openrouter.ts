// =============================================================================
// OpenRouter bridge — Anthropic models via OpenRouter (ERP contour).
// =============================================================================
//
// Why this exists alongside ./anthropic.ts (direct OAuth bridge):
//   The direct OAuth bridge occasionally hits HTTP 524 (Cloudflare edge
//   timeout) on slower calls — e.g. the bank-statement parser feeding a
//   multi-page PDF through a 16k-token extraction prompt. OpenRouter proxies
//   the same Anthropic models (routed here via Amazon Bedrock) without the
//   OAuth identity-preamble dance and has proven more reliable for these
//   longer-running calls. Per Aram (2026-07-06): route bank-statement parser
//   + operation-matcher rule suggester through OpenRouter instead.
//
// Key: env.OPENROUTER_ERP — ERP contour secret (see SECRETS/openrouter.md,
// contour `ERP_API`). Same six-contour OpenRouter setup used elsewhere in
// the Worker (see email-draft.ts, email-classify.ts).
//
// Contract matches the other provider bridges (anthropic.ts / deepseek.ts /
// qwen.ts) so it can be dropped straight into the ./llm.ts router.
// =============================================================================

import type { ChatMessage, LlmResult } from './anthropic';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Verified live against OpenRouter 2026-07-06 — resolves to
// anthropic/claude-4.6-sonnet-20260217 via Amazon Bedrock.
const MODEL_PRO = 'anthropic/claude-sonnet-4.6';
const MODEL_FLASH = 'anthropic/claude-haiku-4.5';

export interface OpenRouterCallOptions {
  apiKey: string;
  maxTokens?: number;
  temperature?: number;
}

async function call(
  model: string,
  messages: ChatMessage[],
  opts: OpenRouterCallOptions,
): Promise<LlmResult> {
  if (!opts.apiKey) {
    throw new Error('OpenRouter call failed: OPENROUTER_ERP not configured');
  }

  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${opts.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: opts.maxTokens ?? 8000,
      temperature: opts.temperature ?? 0.3,
    }),
    // OpenRouter can take a while on long extraction prompts; keep this well
    // under any upstream edge timeout so we get a real error, not a hang.
    signal: AbortSignal.timeout(170_000),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`OpenRouter ${model} failed: HTTP ${res.status} — ${errBody.slice(0, 400)}`);
  }

  const data = await res.json<any>();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error(
      `OpenRouter ${model} returned empty content (finish_reason=${data?.choices?.[0]?.finish_reason ?? 'unknown'})`,
    );
  }

  return {
    text,
    usage: {
      prompt_tokens: data?.usage?.prompt_tokens ?? 0,
      completion_tokens: data?.usage?.completion_tokens ?? 0,
      total_tokens: data?.usage?.total_tokens ?? 0,
    },
    model: data?.model ?? model,
    provider: 'openrouter',
  };
}

export async function callPro(messages: ChatMessage[], opts: OpenRouterCallOptions): Promise<LlmResult> {
  return call(MODEL_PRO, messages, opts);
}

export async function callFlash(messages: ChatMessage[], opts: OpenRouterCallOptions): Promise<LlmResult> {
  return call(MODEL_FLASH, messages, opts);
}
