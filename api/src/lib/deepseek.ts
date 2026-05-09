// =============================================================================
// DeepSeek bridge — single entrypoint for all LLM calls in the ERP.
//
// Routing rule (Phase 5.x architecture decision):
//   PRO   — document generation (NDA, MOU, LOI, contracts, annexes,
//           legal redlines, marketing copy). Quality matters.
//   FLASH — classification, parsing, validation, simple calculations,
//           short summaries. Speed and price matter.
//
// All other files in api/src/ MUST import callPro() or callFlash() from here.
// Direct fetch to api.deepseek.com from other files is forbidden — this gives
// us one token, one error path, one place to swap providers if needed.
// =============================================================================

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1/chat/completions';

const MODEL_PRO = 'deepseek-v4-pro';
const MODEL_FLASH = 'deepseek-v4-flash';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface DeepSeekUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  reasoning_tokens?: number;
}

export interface DeepSeekResult {
  text: string;
  usage: DeepSeekUsage;
  model: string;
}

interface CallOptions {
  /** API key from c.env.DEEPSEEK_API_KEY */
  apiKey: string;
  /** Cap output tokens. Default 8000 for PRO, 2000 for FLASH. */
  maxTokens?: number;
  /** Sampling temperature. Default 0.3 (deterministic for docs). */
  temperature?: number;
}

async function callDeepSeek(
  model: string,
  messages: ChatMessage[],
  opts: CallOptions
): Promise<DeepSeekResult> {
  const body = {
    model,
    messages,
    max_tokens: opts.maxTokens ?? (model === MODEL_PRO ? 8000 : 2000),
    temperature: opts.temperature ?? 0.3,
  };

  const res = await fetch(DEEPSEEK_BASE_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${opts.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`DeepSeek ${model} failed: HTTP ${res.status} — ${errBody.slice(0, 300)}`);
  }

  const data = await res.json() as {
    choices: Array<{ message: { content: string } }>;
    usage: DeepSeekUsage;
  };

  const text = data.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error(`DeepSeek ${model} returned empty response`);
  }

  return {
    text,
    usage: data.usage,
    model,
  };
}

// =============================================================================
// PRO — document generation. Use for any task where output quality matters
// more than speed. Examples: NDA, contracts, marketing copy, legal analysis.
// =============================================================================
export async function callPro(
  messages: ChatMessage[],
  opts: CallOptions
): Promise<DeepSeekResult> {
  return callDeepSeek(MODEL_PRO, messages, opts);
}

// =============================================================================
// FLASH — fast/cheap path. Use for classification, parsing, simple structured
// output, calculations. Output quality is good but PRO is meaningfully better
// on long-form generation.
// =============================================================================
export async function callFlash(
  messages: ChatMessage[],
  opts: CallOptions
): Promise<DeepSeekResult> {
  return callDeepSeek(MODEL_FLASH, messages, opts);
}
