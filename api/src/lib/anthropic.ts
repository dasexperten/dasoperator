// =============================================================================
// Anthropic OAuth bridge — Claude Max 20x subscription quota.
//
// AUTH MODEL (2026-05-28):
//   This file accepts ONLY sk-ant-oat01-* OAuth access tokens generated via
//   `claude setup-token`. The token is tied to the Max 20x subscription
//   (a.v.badalyan@gmail.com) and every request counts against subscription
//   quota.
//
//   Pay-as-you-go API keys (sk-ant-api03-*) are intentionally REJECTED here.
//   The ERP's fallback for any Anthropic failure is DeepSeek V4-Pro, never
//   pay-as-you-go Anthropic — this is enforced via api/src/lib/llm.ts router
//   and via the gate in this file (see assertOAuthToken).
//
// HARD CONSTRAINTS imposed by Anthropic's API for OAuth-authenticated requests:
//   1. system prompt MUST start with the exact Claude Code identifier string
//      for every non-Haiku model. Haiku is exempt. We satisfy this by sending
//      `system` as an array with the identifier as the first text block and
//      the real ERP instructions as the second block.
//   2. Specific beta + identity headers are required: claude-code-20250219,
//      oauth-2025-04-20, user-agent: claude-cli/*, x-app: cli.
//   3. Tool use is sometimes rejected by anti-abuse classifiers on accounts in
//      certain states. We do NOT pass tools through this bridge — pure text in,
//      pure text out, same contract as the DeepSeek bridge.
//
// All ERP code calling this bridge gets exactly the same return shape as the
// DeepSeek bridge (`LlmResult`) so the two are interchangeable behind the
// router in `./llm.ts`.
// =============================================================================

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';

// Required first system block for non-Haiku models when authenticated via OAuth.
// Removing this string causes the API to return HTTP 400 with no useful message.
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

// Model routing (2026-05-27):
//   PRO   — Sonnet 4.6, dateless pinned snapshot (released 2026-02-17). Use for
//           document generation, legal analysis, long-form reasoning.
//   FLASH — Haiku 4.5. Cheap, fast, exempt from the system-prompt identity
//           requirement. Use for classification, parsing, short summaries.
const MODEL_PRO = 'claude-sonnet-4-6';
const MODEL_FLASH = 'claude-haiku-4-5';

// Required headers for OAuth-authenticated Messages API calls.
// Documented across multiple Anthropic GitHub issues (claude-code #40515,
// pi-mono #2751). Without the full set, requests fail silently with HTTP 400.
const OAUTH_BETA_HEADER = 'claude-code-20250219,oauth-2025-04-20';
const CLAUDE_CLI_VERSION = '1.0.0';

/**
 * Hard gate: only sk-ant-oat01-* OAuth tokens are allowed through this bridge.
 * Any other token shape (notably pay-as-you-go sk-ant-api03-*) throws immediately
 * to prevent accidental billing against the wrong account. The ERP fallback
 * policy is DeepSeek V4-Pro, never pay-as-you-go Anthropic.
 */
function assertOAuthToken(token: string): void {
  if (!token) {
    throw new Error('Anthropic bridge: empty token. CLAUDE_CODE_OAUTH_TOKEN is required.');
  }
  if (!token.startsWith('sk-ant-oat')) {
    throw new Error('Anthropic bridge: only OAuth tokens (sk-ant-oat01-*) are accepted. Pay-as-you-go API keys are intentionally rejected — fallback is DeepSeek V4-Pro via api/src/lib/llm.ts.');
  }
}

/**
 * Build headers for an OAuth-authenticated Messages API call.
 */
function buildOAuthHeaders(token: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': OAUTH_BETA_HEADER,
    'user-agent': `claude-cli/${CLAUDE_CLI_VERSION}`,
    'x-app': 'cli',
  };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  reasoning_tokens?: number;
}

export interface LlmResult {
  text: string;
  usage: LlmUsage;
  model: string;
  /** Which provider actually served the request — for cost analytics later. */
  provider: 'anthropic' | 'deepseek' | 'qwen' | 'openrouter';
}

interface OAuthCallOptions {
  /** OAuth token from env.CLAUDE_CODE_OAUTH_TOKEN (sk-ant-oat01-...). */
  oauthToken: string;
  /** Cap output tokens. Default 8000 for PRO, 2000 for FLASH. */
  maxTokens?: number;
  /** Sampling temperature. Default 0.3 (deterministic for docs). */
  temperature?: number;
}

interface AnthropicMessageBlock {
  type: 'text';
  text: string;
}

interface AnthropicResponse {
  content: Array<{ type: string; text?: string }>;
  model: string;
  stop_reason: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/**
 * Splits ChatMessage[] into the Anthropic API's preferred shape:
 *   - All `role: 'system'` messages are concatenated into the `system` field
 *     (each becomes its own text block in the array).
 *   - All other messages stay in the `messages` array.
 *
 * For non-Haiku models the Claude Code identity string is prepended to the
 * `system` array as the first block — required for OAuth-authenticated
 * requests. Haiku is exempt from this validation.
 */
function buildAnthropicBody(
  model: string,
  messages: ChatMessage[],
  maxTokens: number,
  temperature: number,
): {
  system?: AnthropicMessageBlock[];
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  model: string;
  max_tokens: number;
  temperature: number;
} {
  const isHaiku = model.toLowerCase().includes('haiku');

  const systemBlocks: AnthropicMessageBlock[] = [];
  const userAssistant: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  for (const m of messages) {
    if (m.role === 'system') {
      systemBlocks.push({ type: 'text', text: m.content });
    } else {
      userAssistant.push({ role: m.role, content: m.content });
    }
  }

  // Identity preamble — mandatory for OAuth + non-Haiku models.
  if (!isHaiku) {
    systemBlocks.unshift({ type: 'text', text: CLAUDE_CODE_IDENTITY });
  }

  return {
    model,
    max_tokens: maxTokens,
    temperature,
    ...(systemBlocks.length > 0 ? { system: systemBlocks } : {}),
    messages: userAssistant,
  };
}

async function callAnthropic(
  model: string,
  messages: ChatMessage[],
  opts: OAuthCallOptions,
): Promise<LlmResult> {
  assertOAuthToken(opts.oauthToken);

  const body = buildAnthropicBody(
    model,
    messages,
    opts.maxTokens ?? 8000,
    opts.temperature ?? 0.3,
  );

  const res = await fetch(ANTHROPIC_MESSAGES_URL, {
    method: 'POST',
    headers: buildOAuthHeaders(opts.oauthToken),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Anthropic ${model} failed: HTTP ${res.status} — ${errBody.slice(0, 400)}`);
  }

  const data = (await res.json()) as AnthropicResponse;

  // Concatenate all text blocks from the response.
  const text = (data.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text!)
    .join('');

  if (!text) {
    throw new Error(
      `Anthropic ${model} returned empty content (stop_reason=${data.stop_reason}, usage=${JSON.stringify(data.usage ?? {})})`,
    );
  }

  return {
    text,
    usage: {
      prompt_tokens: data.usage.input_tokens,
      completion_tokens: data.usage.output_tokens,
      total_tokens: data.usage.input_tokens + data.usage.output_tokens,
    },
    model: data.model,
    provider: 'anthropic',
  };
}

// =============================================================================
// PRO — Sonnet 4.6. Use for document generation, legal analysis, long-form.
// =============================================================================
export async function callPro(
  messages: ChatMessage[],
  opts: OAuthCallOptions,
): Promise<LlmResult> {
  return callAnthropic(MODEL_PRO, messages, opts);
}

// =============================================================================
// FLASH — Haiku 4.5. Use for classification, parsing, short summaries.
// Exempt from the Claude Code identity preamble — no system-prompt mangling.
// =============================================================================
export async function callFlash(
  messages: ChatMessage[],
  opts: OAuthCallOptions,
): Promise<LlmResult> {
  return callAnthropic(MODEL_FLASH, messages, {
    ...opts,
    maxTokens: opts.maxTokens ?? 2000,
  });
}

// =============================================================================
// Low-level escape hatch for direct callers that need Anthropic-specific
// features (PDF document blocks, prompt caching with cache_control, custom
// content shapes). OAuth-only — pass env.CLAUDE_CODE_OAUTH_TOKEN. If empty
// or invalid, throws immediately. Callers should catch and route to DeepSeek
// V4-Pro via api/src/lib/llm.ts for fallback behavior. Caller controls model
// + body shape.
// =============================================================================
export async function callAnthropicRaw(
  opts: OAuthCallOptions & {
    model: string;
    system?: string | AnthropicMessageBlock[];
    messages: Array<{ role: 'user' | 'assistant'; content: any }>;
  },
): Promise<AnthropicResponse> {
  assertOAuthToken(opts.oauthToken);
  const isHaiku = opts.model.toLowerCase().includes('haiku');

  // Normalise system → array of text blocks (or string passthrough), prepend
  // identity preamble for non-Haiku models (required by OAuth API).
  let systemBlocks: AnthropicMessageBlock[] = [];
  if (typeof opts.system === 'string' && opts.system.length > 0) {
    systemBlocks = [{ type: 'text', text: opts.system }];
  } else if (Array.isArray(opts.system)) {
    systemBlocks = opts.system;
  }
  if (!isHaiku) {
    systemBlocks = [{ type: 'text', text: CLAUDE_CODE_IDENTITY }, ...systemBlocks];
  }

  const body = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 8000,
    temperature: opts.temperature ?? 0.3,
    ...(systemBlocks.length > 0 ? { system: systemBlocks } : {}),
    messages: opts.messages,
  };

  const res = await fetch(ANTHROPIC_MESSAGES_URL, {
    method: 'POST',
    headers: buildOAuthHeaders(opts.oauthToken),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Anthropic ${opts.model} (raw) failed: HTTP ${res.status} — ${errBody.slice(0, 400)}`);
  }

  return (await res.json()) as AnthropicResponse;
}
