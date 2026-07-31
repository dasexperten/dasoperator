// =============================================================================
// Owner 2026-07-31: a letter that is neither Russian nor English gets a
// "Перевести" button in the Emailer. This is the endpoint behind it.
//
// MODEL POLICY (Owner, explicit): Sonnet — and Sonnet on the retry too.
//   1st attempt : prefer 'anthropic'  → claude-sonnet-4-6 over the Max 20x
//                 OAuth bridge (subscription quota, not pay-as-you-go).
//   2nd attempt : prefer 'openrouter' → the SAME Sonnet through OPENROUTER_ERP,
//                 used when the direct OAuth bridge is flaky.
//   There is deliberately NO DeepSeek fallback here. The router's default is
//   DeepSeek; a translation that silently downgraded would be a different
//   product than the one the Owner asked for.
//
// The model reports the source language itself, so the UI never has to trust
// the client-side detector that decided to show the button.
// =============================================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { validateSession } from '../lib/auth';
import { callPro } from '../lib/llm';
import type { ChatMessage } from '../lib/llm';

/** Letters longer than this are truncated — a translation is for reading, not archiving. */
const MAX_CHARS = 12000;

const SYSTEM = [
  'You are a professional business translator working inside an ERP mail client.',
  'You translate incoming business correspondence into the requested target language.',
  '',
  'Rules:',
  '- Translate meaning, not words. Business register, natural in the target language.',
  '- Keep every number, currency, date, SKU, invoice id, weight and email address byte-exact.',
  '- Keep names of people, companies and products in their original spelling.',
  '- Preserve paragraph breaks. Do not add commentary, notes or apologies.',
  '- Quoted history at the bottom of a letter is translated too, keep its markers.',
  '',
  'Answer in exactly this shape and nothing else:',
  'LANG: <source language, named in the target language>',
  '---',
  '<the translation>',
].join('\n');

function bearer(c: import('hono').Context<{ Bindings: Env }>): string | null {
  const h = c.req.header('authorization') || '';
  return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : null;
}

async function requireSession(c: import('hono').Context<{ Bindings: Env }>): Promise<boolean> {
  const token = bearer(c);
  if (!token) return false;
  return !!(await validateSession(c.env.DB, token));
}

/** Strip an HTML letter down to readable text — the model gets prose, not markup. */
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Split the model's answer into the language line and the body. */
function parseAnswer(raw: string): { sourceLanguage: string; translation: string } {
  const text = (raw || '').trim();
  const m = text.match(/^LANG:\s*(.+?)\s*\n-{3,}\n([\s\S]*)$/);
  if (m) return { sourceLanguage: m[1]!.trim(), translation: m[2]!.trim() };
  // Model ignored the shape — hand back what it produced rather than an error.
  return { sourceLanguage: '', translation: text };
}

const route = new Hono<{ Bindings: Env }>();

/**
 * POST /api/email/translate
 * body: { text?, html?, target? }  target defaults to Russian.
 * result: { translation, sourceLanguage, target, provider, model, truncated }
 */
route.post('/translate', async (c) => {
  if (!(await requireSession(c))) {
    return fail(c, 401, [{ code: 'unauthorized', message: 'valid session required' }]);
  }

  const body = await c.req
    .json<{ text?: string; html?: string; target?: string }>()
    .catch(() => ({}) as { text?: string; html?: string; target?: string });

  const target = (body.target || '').trim() || 'Russian';
  const raw = (body.text || '').trim() || (body.html ? htmlToText(body.html) : '');

  if (!raw) return fail(c, 400, [{ code: 'empty_body', message: 'nothing to translate' }]);

  const truncated = raw.length > MAX_CHARS;
  const source = truncated ? `${raw.slice(0, MAX_CHARS)}\n\n[...]` : raw;

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `Target language: ${target}\n\nLetter:\n\n${source}` },
  ];

  const attempt = async (prefer: 'anthropic' | 'openrouter') =>
    callPro(messages, { env: c.env, prefer, maxTokens: 8000, temperature: 0.2 });

  let result;
  try {
    result = await attempt('anthropic');
  } catch (first) {
    try {
      result = await attempt('openrouter');
    } catch (second) {
      const why = second instanceof Error ? second.message : String(second);
      const firstWhy = first instanceof Error ? first.message : String(first);
      return fail(c, 502, [
        { code: 'translate_failed', message: `Sonnet unavailable on both routes: ${firstWhy} | ${why}` },
      ]);
    }
  }

  const parsed = parseAnswer(result.text);
  if (!parsed.translation) {
    return fail(c, 502, [{ code: 'empty_translation', message: 'model returned nothing' }]);
  }

  return ok(c, {
    translation: parsed.translation,
    sourceLanguage: parsed.sourceLanguage,
    target,
    provider: result.provider,
    model: result.model,
    truncated,
  });
});

export default route;
