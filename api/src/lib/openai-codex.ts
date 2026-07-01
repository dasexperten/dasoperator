// =============================================================================
// codex-bridge client — gpt-5.5 via the ChatGPT-Plus OAuth session on
// hermes-vps (the Worker cannot call ChatGPT OAuth directly; see
// SECRETS/openai.md). HMAC-signed. Used as the PRIMARY engine for review reply
// generation; callers fall back to DeepSeek when this throws (quota spent).
// =============================================================================
import type { Env } from '../types';

async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function codexGenerate(
  env: Env, system: string, user: string,
  opts: { model?: string; timeoutMs?: number } = {},
): Promise<string> {
  const url = env.CODEX_BRIDGE_URL;
  const secret = env.CODEX_BRIDGE_HMAC_SECRET;
  if (!url || !secret) throw new Error('codex bridge not configured');
  const body = JSON.stringify({ system, user, ...(opts.model ? { model: opts.model } : {}) });
  const resp = await fetch(url.replace(/\/$/, '') + '/v1/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bridge-Signature': 'sha256=' + (await sign(secret, body)) },
    body,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 90_000),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`codex bridge HTTP ${resp.status}: ${t.slice(0, 160)}`);
  }
  const j = await resp.json<{ text?: string }>();
  const text = (j.text ?? '').trim();
  if (!text) throw new Error('codex bridge returned empty text');
  return text;
}
