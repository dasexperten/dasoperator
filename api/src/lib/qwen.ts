// =============================================================================
// Qwen (Alibaba DashScope) bridge — OpenAI-compatible, INTERNATIONAL endpoint.
//
// Role (2026-06-10, per Aram): answer-writer for RATING-ONLY reviews (buyer
// left a star rating, no text). Text reviews are written by Claude Sonnet; all
// analytical gates run on DeepSeek. Qwen sits only on the rating-only write.
//
// Model: qwen-max (verified HTTP 200 on the intl compatible-mode host).
// qwen-plus is intentionally NOT used — free tier exhausted (403).
// Key: env.DASHSCOPE_API_KEY (intl-scoped). RU/CN host rejects it (401).
// =============================================================================

const QWEN_BASE_URL =
  'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions';

const MODEL_MAX = 'qwen-max';

export interface QwenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface QwenResult {
  text: string;
  usage: QwenUsage;
  model: string;
}

interface QwenCallOptions {
  /** API key from env.DASHSCOPE_API_KEY (intl-scoped sk-ws-...). */
  apiKey: string;
  maxTokens?: number;
  temperature?: number;
}

export interface QwenChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

async function callQwenModel(
  model: string,
  messages: QwenChatMessage[],
  opts: QwenCallOptions,
): Promise<QwenResult> {
  const body = {
    model,
    messages,
    max_tokens: opts.maxTokens ?? 1500,
    temperature: opts.temperature ?? 0.4,
  };

  const res = await fetch(QWEN_BASE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Qwen ${model} failed: HTTP ${res.status} — ${errBody.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    usage?: QwenUsage;
  };

  const text = data.choices?.[0]?.message?.content;
  if (!text) {
    const finish = data.choices?.[0]?.finish_reason ?? 'unknown';
    throw new Error(`Qwen ${model} returned empty content (finish=${finish})`);
  }

  return {
    text,
    usage: data.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    model,
  };
}

// PRO/answer — qwen-max. Used for rating-only review replies.
export async function callPro(
  messages: QwenChatMessage[],
  opts: QwenCallOptions,
): Promise<QwenResult> {
  return callQwenModel(MODEL_MAX, messages, opts);
}

export async function callFlash(
  messages: QwenChatMessage[],
  opts: QwenCallOptions,
): Promise<QwenResult> {
  return callQwenModel(MODEL_MAX, messages, opts);
}
