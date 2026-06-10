// =============================================================================
// Gemini API bridge — used for rating-only review replies.
// All other gates (analytical) still go through DeepSeek.
// Text reviews still go through Claude (lib/anthropic).
//
// Gemini 2.5 Flash: $0.30/M input, $2.50/M output — 10x cheaper than Claude.
// Thinking budget disabled (thinkingConfig.thinkingBudget=0) for speed.
// =============================================================================

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

export interface GeminiUsage {
  prompt_tokens: number;
  completion_tokens: number;
}

export interface GeminiResult {
  text: string;
  usage: GeminiUsage;
  model: string;
}

export interface GeminiOpts {
  apiKey: string;
  maxTokens?: number;
  temperature?: number;
  thinkingBudget?: number;  // default 0 (disabled) — Flash is fine without
}

export async function callGeminiFlash(
  system: string,
  user: string,
  opts: GeminiOpts,
): Promise<GeminiResult> {
  const body = {
    contents: [{ parts: [{ text: user }] }],
    systemInstruction: { parts: [{ text: system }] },
    generationConfig: {
      maxOutputTokens: opts.maxTokens ?? 1500,
      temperature: opts.temperature ?? 0.5,
      thinkingConfig: { thinkingBudget: opts.thinkingBudget ?? 0 },
    },
  };

  const url = `${GEMINI_URL}?key=${opts.apiKey}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Gemini Flash HTTP ${resp.status}: ${t.slice(0, 400)}`);
  }

  const data = await resp.json() as any;
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  if (!text) {
    const finishReason = data?.candidates?.[0]?.finishReason ?? 'unknown';
    throw new Error(`Gemini Flash returned empty content (finish=${finishReason})`);
  }

  const usage = data?.usageMetadata ?? {};
  return {
    text: text.trim(),
    usage: {
      prompt_tokens: usage.promptTokenCount ?? 0,
      completion_tokens: usage.candidatesTokenCount ?? 0,
    },
    model: 'gemini-2.5-flash',
  };
}

// =============================================================================
// Gemini 3.5 Flash — MULTIMODAL (PDF). Email/inbox task model (per Aram
// 2026-06-10): invoice / УПД / счёт extraction from raw PDF. Native PDF
// reading via inline_data; DeepSeek can't take document blocks, so this is the
// primary path with a Claude-Sonnet multimodal fallback in the caller.
// =============================================================================
const GEMINI_MM_MODEL = 'gemini-3.5-flash';
const GEMINI_MM_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MM_MODEL}:generateContent`;

export async function callGeminiPdf(
  system: string,
  userText: string,
  pdfBase64: string,
  opts: GeminiOpts,
): Promise<GeminiResult> {
  const body = {
    contents: [
      {
        parts: [
          { inline_data: { mime_type: 'application/pdf', data: pdfBase64 } },
          { text: userText },
        ],
      },
    ],
    systemInstruction: { parts: [{ text: system }] },
    generationConfig: {
      maxOutputTokens: opts.maxTokens ?? 2500,
      temperature: opts.temperature ?? 0.2,
      thinkingConfig: { thinkingBudget: opts.thinkingBudget ?? 0 },
    },
  };

  const url = `${GEMINI_MM_URL}?key=${opts.apiKey}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Gemini PDF HTTP ${resp.status}: ${t.slice(0, 400)}`);
  }

  const data = (await resp.json()) as any;
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  if (!text) {
    const finishReason = data?.candidates?.[0]?.finishReason ?? 'unknown';
    throw new Error(`Gemini PDF returned empty content (finish=${finishReason})`);
  }

  const usage = data?.usageMetadata ?? {};
  return {
    text: text.trim(),
    usage: {
      prompt_tokens: usage.promptTokenCount ?? 0,
      completion_tokens: usage.candidatesTokenCount ?? 0,
    },
    model: GEMINI_MM_MODEL,
  };
}
