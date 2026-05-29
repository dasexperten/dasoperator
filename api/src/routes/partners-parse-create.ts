// =============================================================================
// POST /api/partners/parse-and-create
//
// Accepts raw text + optional file (base64), runs it through DeepSeek to
// extract shipper details, returns parsed fields OR creates the partner.
//
// Two modes via `mode` field in body:
//   - 'parse'  → return parsed fields only (preview in UI)
//   - 'create' → create partners row with kind='shipper', return new partner
//
// CEMENTED (2026-05-29): never fabricate INN/legal data. If a field can't be
// extracted with confidence, return null — UI handles the missing piece.
// =============================================================================

import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { ok, fail } from '../lib/response';
import { callPro } from '../lib/deepseek';
import { generateReadablePartnerId } from '../lib/partner-dedup';

const route = new Hono<{ Bindings: Env }>();

const reqSchema = z.object({
  mode: z.enum(['parse', 'create']),
  text: z.string().max(20000).nullable().optional(),
  // base64 of file content; mime tells us pdf/image/text
  file_base64: z.string().nullable().optional(),
  file_mime: z.string().nullable().optional(),
  file_name: z.string().nullable().optional(),
  // for mode='create' — UI sends edited fields back
  parsed: z.object({
    trade_name: z.string().nullable().optional(),
    legal_name: z.string().nullable().optional(),
    country: z.string().nullable().optional(),
    inn: z.string().nullable().optional(),
    contact_person: z.string().nullable().optional(),
    contact_phone: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    address: z.string().nullable().optional(),
    bank_name: z.string().nullable().optional(),
    bank_account: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
  }).nullable().optional(),
});

const PARSE_PROMPT = `You are a counterparty-details extractor for a logistics company onboarding flow.

You receive ONE input (raw text from an email/message, OR text extracted from a PDF/image). Extract the company that is being introduced as a SHIPPER / freight forwarder / logistics provider.

Output ONLY valid JSON, no commentary:
{
  "trade_name": string | null,       // short display name, e.g. "DD Logistics"
  "legal_name": string | null,       // full legal form, e.g. "ООО Логистик-Восток"
  "country": string | null,          // e.g. "Russia", "China", "Vietnam"
  "inn": string | null,              // tax id; for RU 10 or 12 digits only
  "contact_person": string | null,
  "contact_phone": string | null,    // +XX format if visible
  "email": string | null,            // single email; if multiple, pick the first generic one
  "address": string | null,
  "bank_name": string | null,
  "bank_account": string | null,
  "notes": string | null             // anything notable for the operator
}

RULES:
- Never invent values. If unclear, return null.
- Phone: keep digits, +, spaces, dashes; no parentheses.
- INN: digits only, no spaces.
- For Russian counterparties, prefer Russian-language legal_name verbatim ("ООО ...").
- trade_name should be human-friendly: drop ООО / OOO / ЗАО / LLC unless it IS the brand.`;

route.post('/parse-and-create', async (c) => {
  let body: z.infer<typeof reqSchema>;
  try {
    const raw = await c.req.json();
    body = reqSchema.parse(raw);
  } catch (e) {
    return fail(c, 400, [{ code: 'invalid_body', message: e instanceof Error ? e.message : 'bad body' }]);
  }

  // ---- mode='create' — UI confirmed parsed fields ------------------------
  if (body.mode === 'create') {
    const p = body.parsed;
    if (!p || !p.trade_name || !p.trade_name.trim()) {
      return fail(c, 422, [{ code: 'missing_name', message: 'trade_name is required' }]);
    }

    // Check duplicate by INN (strongest dedup signal) or by trade_name
    if (p.inn) {
      const dup = await c.env.DB.prepare(
        `SELECT id, slug, trade_name FROM partners WHERE inn = ? AND deleted_at IS NULL LIMIT 1`
      ).bind(p.inn).first<{ id: string; slug: string; trade_name: string }>();
      if (dup) {
        return ok(c, { partner: dup, duplicate: true, message: `Already exists as "${dup.trade_name}"` });
      }
    }

    const id = await generateReadablePartnerId(c.env.DB, p.trade_name);
    const slug = id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const now = Math.floor(Date.now() / 1000);

    // Heuristic for partner_language from country
    const lang = p.country?.toLowerCase().includes('russia') ? 'RU'
      : p.country?.toLowerCase().includes('china') ? 'EN-ZH'
      : p.country?.toLowerCase().includes('vietnam') ? 'EN-VI'
      : 'EN';

    await c.env.DB.prepare(`
      INSERT INTO partners (
        id, slug, trade_name, legal_name, country, inn,
        email, address, contact_person, partner_language,
        bank_name, notes,
        kind, partner_type, partner_subtype, status, crm_status,
        acceptance_required,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'shipper', 'shipper', 'logistics', 'active', 'active', 1, ?, ?)
    `).bind(
      id, slug, p.trade_name.trim(),
      p.legal_name ?? null,
      p.country ?? null,
      p.inn ?? null,
      p.email ?? null,
      p.address ?? null,
      p.contact_person ?? null,
      lang,
      p.bank_name ?? null,
      p.notes ?? null,
      now, now,
    ).run();

    const created = await c.env.DB.prepare(
      `SELECT id, slug, trade_name, country, email FROM partners WHERE id = ?`
    ).bind(id).first<{ id: string; slug: string; trade_name: string; country: string | null; email: string | null }>();

    return ok(c, { partner: created, duplicate: false });
  }

  // ---- mode='parse' — run extractor and return fields --------------------
  // Compose input — text + (if file is text/plain) decoded file body
  let input = (body.text ?? '').trim();
  if (body.file_base64 && body.file_mime) {
    if (body.file_mime.startsWith('text/') || body.file_mime === 'application/json') {
      try {
        const decoded = atob(body.file_base64);
        input = `${input}\n\n--- attached: ${body.file_name ?? 'file'} ---\n${decoded}`.trim();
      } catch {
        // ignore
      }
    } else {
      // Non-text file — pass filename + a marker; future: route through Claude Vision for PDF/image
      input = `${input}\n\n[attached file: ${body.file_name ?? 'unknown'} (${body.file_mime}) — text could not be extracted in this mode]`.trim();
    }
  }

  if (!input) {
    return fail(c, 400, [{ code: 'no_input', message: 'text or file required' }]);
  }

  try {
    const res = await callPro(
      [
        { role: 'system', content: PARSE_PROMPT },
        { role: 'user', content: input.slice(0, 18000) },
      ],
      { apiKey: c.env.DEEPSEEK_API_KEY, temperature: 0.1, maxTokens: 1500 },
    );

    let parsed: Record<string, string | null>;
    try {
      const cleaned = res.text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      parsed = JSON.parse(cleaned);
    } catch {
      return fail(c, 502, [{ code: 'bad_llm_json', message: 'parser returned non-JSON' }]);
    }

    return ok(c, { parsed });
  } catch (e) {
    return fail(c, 500, [{ code: 'parser_error', message: e instanceof Error ? e.message : 'unknown' }]);
  }
});

export default route;
