// =============================================================================
// LLM router — single entrypoint for ERP business logic that needs reasoning.
//
// ROUTING POLICY (2026-05-27):
//   1. PRIMARY: Anthropic Sonnet 4.6 (PRO) / Haiku 4.5 (FLASH) via OAuth token
//      from env.CLAUDE_CODE_OAUTH_TOKEN — counts against Max 20x subscription
//      quota, not pay-as-you-go API credits.
//   2. FALLBACK: DeepSeek V4-Pro via env.DEEPSEEK_API_KEY — kicks in when:
//        a) CLAUDE_CODE_OAUTH_TOKEN is not configured on this Worker,
//        b) Anthropic call returns a hard failure (HTTP 429 rate limit,
//           5xx server error, or any thrown exception).
//
// The router never silently degrades on success — it always reports which
// provider actually served the request via `result.provider`. Call sites can
// log this for cost tracking; nothing else needs to change.
//
// ALL new ERP code that needs an LLM SHOULD import from this file, NOT from
// './deepseek' or './anthropic' directly. The two underlying bridges remain
// usable for the rare cases where a caller specifically needs to pin one
// provider (e.g. running side-by-side comparison evals).
// =============================================================================

import type { Env } from '../types';
import { callPro as anthropicPro, callFlash as anthropicFlash } from './anthropic';
import { callPro as deepseekPro, callFlash as deepseekFlash } from './deepseek';

// Re-export the shared message + result types so call sites import everything
// from a single module.
export type { ChatMessage, LlmResult, LlmUsage } from './anthropic';
import type { ChatMessage, LlmResult } from './anthropic';

export interface LlmCallOptions {
  /** Cloudflare Worker env binding — gives the router access to both keys. */
  env: Env;
  /** Cap output tokens. Default 8000 for PRO, 2000 for FLASH. */
  maxTokens?: number;
  /** Sampling temperature. Default 0.3 (deterministic for docs). */
  temperature?: number;
  /**
   * Force a specific provider. Defaults to 'auto' (Anthropic with DeepSeek
   * fallback). Set 'deepseek' to skip Anthropic entirely — useful for the
   * occasional caller that wants the cheaper provider regardless.
   */
  prefer?: 'auto' | 'anthropic' | 'deepseek';
}

function shouldFallbackOn(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // Fall back on rate limit, server error, auth issues, or any thrown error.
  // Empty content from Anthropic also falls back (different prompt sensitivity).
  return /HTTP (4(?:00|01|03|29)|5\d\d)|empty content|fetch failed|network/i.test(msg);
}

async function route(
  messages: ChatMessage[],
  opts: LlmCallOptions,
  variant: 'pro' | 'flash',
): Promise<LlmResult> {
  const { env, maxTokens, temperature, prefer = 'auto' } = opts;

  const anthropicAvailable = !!env.CLAUDE_CODE_OAUTH_TOKEN;
  const deepseekAvailable = !!env.DEEPSEEK_API_KEY;

  if (!anthropicAvailable && !deepseekAvailable) {
    throw new Error('LLM router: no provider configured — both CLAUDE_CODE_OAUTH_TOKEN and DEEPSEEK_API_KEY are missing');
  }

  // Build opts objects without inserting `undefined` values — keeps the
  // exactOptionalPropertyTypes TS check happy on Cloudflare Workers.
  const dsOpts = {
    apiKey: env.DEEPSEEK_API_KEY,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
  };
  const anOpts = {
    oauthToken: env.CLAUDE_CODE_OAUTH_TOKEN ?? '',
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
  };

  // Caller explicitly asked for DeepSeek — skip Anthropic.
  if (prefer === 'deepseek' || !anthropicAvailable) {
    if (!deepseekAvailable) {
      throw new Error('LLM router: DeepSeek requested but DEEPSEEK_API_KEY is not set');
    }
    const r = variant === 'pro'
      ? await deepseekPro(messages, dsOpts)
      : await deepseekFlash(messages, dsOpts);
    return { ...r, provider: 'deepseek' };
  }

  // Caller pinned Anthropic — no fallback.
  if (prefer === 'anthropic') {
    return variant === 'pro'
      ? await anthropicPro(messages, anOpts)
      : await anthropicFlash(messages, anOpts);
  }

  // AUTO: try Anthropic first, fall back to DeepSeek on hard failures.
  try {
    return variant === 'pro'
      ? await anthropicPro(messages, anOpts)
      : await anthropicFlash(messages, anOpts);
  } catch (err) {
    if (!deepseekAvailable || !shouldFallbackOn(err)) {
      throw err;
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    console.warn(`[llm-router] Anthropic ${variant} failed, falling back to DeepSeek: ${errMsg.slice(0, 200)}`);
    const r = variant === 'pro'
      ? await deepseekPro(messages, dsOpts)
      : await deepseekFlash(messages, dsOpts);
    return { ...r, provider: 'deepseek' };
  }
}

// =============================================================================
// PRO — Sonnet 4.6 (primary) / DeepSeek V4-Pro (fallback).
// Use for document generation, legal analysis, long-form reasoning, contracts.
// =============================================================================
export async function callPro(
  messages: ChatMessage[],
  opts: LlmCallOptions,
): Promise<LlmResult> {
  return route(messages, opts, 'pro');
}

// =============================================================================
// FLASH — Haiku 4.5 (primary) / DeepSeek V4-Pro (fallback).
// Use for classification, parsing, short summaries, light reasoning.
// =============================================================================
export async function callFlash(
  messages: ChatMessage[],
  opts: LlmCallOptions,
): Promise<LlmResult> {
  return route(messages, opts, 'flash');
}
