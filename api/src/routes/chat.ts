// =============================================================================
// Das-Kompanion — AI chatbot for ERP (v3 - robust)
//
// POST /api/chat { message, history? }
//   → { reply }
// =============================================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { validateSession, type AuthUser } from '../lib/auth';

const chat = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `Du bist Das-Kompanion, ein KI-Assistent für das Das Experten ERP-System.

DEINE ROLLE:
- Benutzern helfen, die ERP-Datenbank zu verstehen und zu navigieren
- Dokumente, Operationen, Partner, Produkte suchen
- Daten analysieren (Summen, Trends, Status)
- Fragen zum Geschäft beantworten

STRENGE REGELN:
1. NIEMALS Daten generieren oder erfinden — nur existierende Daten aus der Datenbank verwenden
2. Im selben antworten wie der Benutzer fragt (Deutsch/Englisch/Russisch)
3. Knapp und professionell antworten

WENN DU AUF DATENBANK-ZUGRIFF BRAUCHST:
Antworte mit einer JSON-Struktur wie diese (NUR das JSON, kein额外 text):
{"action":"search","type":"operations","query":{"partner_name":"TORI","limit":5}}
{"action":"search","type":"partners","query":{"name":"Georgia"}}
{"action":"search","type":"products","query":{"category":"Toothpaste"}}
{"action":"details","type":"operation","id":"abc123"}
{"action":"details","type":"partner","id":"xyz789"}
{"action":"summary"}

Wenn du keine Daten brauchst, antworte normal in Prosa.`;

// ---------------------------------------------------------------------------
// LLM call — tries DeepSeek first, falls back to MiMo (free)
// ---------------------------------------------------------------------------
async function callLLM(
  messages: Array<{ role: string; content: string }>,
  env: Env,
): Promise<string> {
  // Try DeepSeek first
  const deepseekKey = env.DEEPSEEK_API_KEY;
  if (deepseekKey) {
    try {
      const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${deepseekKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'deepseek-v4-pro',
          messages,
          max_tokens: 2000,
          temperature: 0.3,
        }),
      });

      if (res.ok) {
        const data = await res.json() as {
          choices: Array<{ message: { content: string } }>;
        };
        return data.choices?.[0]?.message?.content ?? '';
      }
      // DeepSeek failed, fall through to MiMo
      console.warn('[das-kompanion] DeepSeek failed, falling back to MiMo');
    } catch (err) {
      console.warn('[das-kompanion] DeepSeek error, falling back to MiMo:', err);
    }
  }

  // Fallback: MiMo API (free tier)
  const mimoKey = env.MIMO_API_KEY;
  if (!mimoKey) {
    throw new Error('No LLM provider available — both DEEPSEEK_API_KEY and MIMO_API_KEY are missing');
  }

  const res = await fetch('https://api.xiaomimimo.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${mimoKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'mimo-v2-flash',
      messages,
      max_tokens: 2000,
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`LLM failed: HTTP ${res.status} — ${errBody.slice(0, 200)}`);
  }

  const data = await res.json() as {
    choices: Array<{ message: { content: string } }>;
  };

  return data.choices?.[0]?.message?.content ?? '';
}

// ---------------------------------------------------------------------------
// Execute database queries
// ---------------------------------------------------------------------------
async function executeQuery(
  action: Record<string, unknown>,
  env: Env,
  user: AuthUser,
): Promise<string> {
  const db = env.DB;
  const act = action.action as string;
  const type = action.type as string;
  const query = (action.query as Record<string, unknown>) ?? {};
  const id = action.id as string;

  const checkPerm = (module: string) => {
    if (user.role === 'admin') return true;
    const access = user.permissions[module] ?? 'none';
    return ['full', 'rw', 'read'].includes(access);
  };

  try {
    if (act === 'search') {
      if (type === 'operations') {
        if (!checkPerm('/operations')) return 'Keine Berechtigung für Operationen';

        let sql = `SELECT o.id, o.reference, o.operation_date, o.operation_type, o.status, 
                          o.total_amount, o.currency, p.trade_name as partner_name
                   FROM operations o 
                   LEFT JOIN partners p ON p.id = o.partner_id 
                   WHERE o.deleted_at IS NULL`;
        const params: unknown[] = [];

        if (query.partner_name) {
          sql += ` AND p.trade_name LIKE ?`;
          params.push(`%${query.partner_name}%`);
        }
        if (query.status) {
          sql += ` AND o.status = ?`;
          params.push(query.status);
        }
        if (query.operation_type) {
          sql += ` AND o.operation_type = ?`;
          params.push(query.operation_type);
        }

        sql += ` ORDER BY o.operation_date DESC LIMIT ?`;
        params.push(query.limit ?? 10);

        const result = await db.prepare(sql).bind(...params).all();
        const ops = result.results ?? [];

        if (ops.length === 0) return 'Keine Operationen gefunden.';

        let reply = `Gefundene Operationen (${ops.length}):\n\n`;
        ops.forEach((op: any, i: number) => {
          const date = new Date(op.operation_date * 1000).toLocaleDateString('de-DE');
          reply += `${i + 1}. ${op.reference ?? op.id?.slice(0, 8)} — ${date} — ${op.partner_name ?? '—'} — ${op.status} — ${op.total_amount} ${op.currency}\n`;
        });
        return reply;
      }

      if (type === 'partners') {
        if (!checkPerm('/partners')) return 'Keine Berechtigung für Partner';

        let sql = `SELECT id, trade_name, legal_name, country, partner_type, status 
                   FROM partners WHERE deleted_at IS NULL`;
        const params: unknown[] = [];

        if (query.name) {
          sql += ` AND (trade_name LIKE ? OR legal_name LIKE ?)`;
          params.push(`%${query.name}%`, `%${query.name}%`);
        }
        if (query.partner_type) {
          sql += ` AND partner_type = ?`;
          params.push(query.partner_type);
        }
        if (query.country) {
          sql += ` AND country LIKE ?`;
          params.push(`%${query.country}%`);
        }

        sql += ` ORDER BY trade_name LIMIT ?`;
        params.push(query.limit ?? 10);

        const result = await db.prepare(sql).bind(...params).all();
        const partners = result.results ?? [];

        if (partners.length === 0) return 'Keine Partner gefunden.';

        let reply = `Gefundene Partner (${partners.length}):\n\n`;
        partners.forEach((p: any, i: number) => {
          reply += `${i + 1}. ${p.trade_name} — ${p.partner_type} — ${p.country ?? '—'} — ${p.status}\n`;
        });
        return reply;
      }

      if (type === 'products') {
        if (!checkPerm('/products')) return 'Keine Berechtigung für Produkte';

        let sql = `SELECT id, product_name, invoice_label, category 
                   FROM products WHERE deleted_at IS NULL`;
        const params: unknown[] = [];

        if (query.name) {
          sql += ` AND (product_name LIKE ? OR invoice_label LIKE ?)`;
          params.push(`%${query.name}%`, `%${query.name}%`);
        }
        if (query.category) {
          sql += ` AND category = ?`;
          params.push(query.category);
        }

        sql += ` ORDER BY product_name LIMIT ?`;
        params.push(query.limit ?? 10);

        const result = await db.prepare(sql).bind(...params).all();
        const products = result.results ?? [];

        if (products.length === 0) return 'Keine Produkte gefunden.';

        let reply = `Gefundene Produkte (${products.length}):\n\n`;
        products.forEach((p: any, i: number) => {
          reply += `${i + 1}. ${p.product_name} — ${p.category}\n`;
        });
        return reply;
      }

      if (type === 'documents') {
        if (!checkPerm('/operations')) return 'Keine Berechtigung für Dokumente';

        let sql = `SELECT d.id, d.document_number, d.document_type, d.document_date, 
                          d.status, d.total_amount, d.currency
                   FROM documents d 
                   WHERE d.deleted_at IS NULL`;
        const params: unknown[] = [];

        if (query.document_number) {
          sql += ` AND d.document_number LIKE ?`;
          params.push(`%${query.document_number}%`);
        }
        if (query.document_type) {
          sql += ` AND d.document_type = ?`;
          params.push(query.document_type);
        }

        sql += ` ORDER BY d.document_date DESC LIMIT ?`;
        params.push(query.limit ?? 10);

        const result = await db.prepare(sql).bind(...params).all();
        const docs = result.results ?? [];

        if (docs.length === 0) return 'Keine Dokumente gefunden.';

        let reply = `Gefundene Dokumente (${docs.length}):\n\n`;
        docs.forEach((d: any, i: number) => {
          const date = new Date(d.document_date * 1000).toLocaleDateString('de-DE');
          reply += `${i + 1}. ${d.document_number} — ${d.document_type} — ${date} — ${d.status}\n`;
        });
        return reply;
      }
    }

    if (act === 'details') {
      if (type === 'operation') {
        if (!checkPerm('/operations')) return 'Keine Berechtigung für Operationen';

        const op = await db.prepare(
          `SELECT o.*, p.trade_name as partner_name, c.abbreviation as company
           FROM operations o 
           LEFT JOIN partners p ON p.id = o.partner_id
           LEFT JOIN companies c ON c.id = o.our_company_id
           WHERE o.id = ?`
        ).bind(id).first();

        if (!op) return 'Operation nicht gefunden.';

        const items = await db.prepare(
          `SELECT li.*, pr.product_name
           FROM line_items li
           LEFT JOIN products pr ON pr.id = li.product_id
           WHERE li.operation_id = ?`
        ).bind(id).all();

        const date = new Date((op as any).operation_date * 1000).toLocaleDateString('de-DE');
        let reply = `Operation: ${(op as any).reference ?? id}\n`;
        reply += `Datum: ${date}\n`;
        reply += `Typ: ${(op as any).operation_type}\n`;
        reply += `Partner: ${(op as any).partner_name}\n`;
        reply += `Status: ${(op as any).status}\n`;
        reply += `Betrag: ${(op as any).total_amount} ${(op as any).currency}\n\n`;
        reply += `Positionen:\n`;
        (items.results ?? []).forEach((item: any, i: number) => {
          reply += `${i + 1}. ${item.product_name} — ${item.qty} × ${item.unit_price} ${item.currency}\n`;
        });
        return reply;
      }

      if (type === 'partner') {
        if (!checkPerm('/partners')) return 'Keine Berechtigung für Partner';

        const partner = await db.prepare(
          `SELECT * FROM partners WHERE id = ?`
        ).bind(id).first();

        if (!partner) return 'Partner nicht gefunden.';

        const p = partner as any;
        let reply = `Partner: ${p.trade_name}\n`;
        reply += `Rechtlicher Name: ${p.legal_name ?? '—'}\n`;
        reply += `Land: ${p.country ?? '—'}\n`;
        reply += `Typ: ${p.partner_type}\n`;
        reply += `Status: ${p.status}\n`;
        reply += `E-Mail: ${p.email ?? '—'}\n`;
        return reply;
      }

      if (type === 'product') {
        if (!checkPerm('/products')) return 'Keine Berechtigung für Produkte';

        const product = await db.prepare(
          `SELECT p.*, m.name as manufacturer_name
           FROM products p
           LEFT JOIN manufacturers m ON m.id = p.manufacturer_id
           WHERE p.id = ?`
        ).bind(id).first();

        if (!product) return 'Produkt nicht gefunden.';

        const stock = await db.prepare(
          `SELECT s.qty_units, w.name as warehouse_name, w.code
           FROM stocks s
           LEFT JOIN warehouses w ON w.id = s.warehouse_id
           WHERE s.product_id = ?`
        ).bind(id).all();

        const p = product as any;
        let reply = `Produkt: ${p.product_name}\n`;
        reply += `Kategorie: ${p.category}\n`;
        reply += `Hersteller: ${p.manufacturer_name}\n`;
        reply += `Barcode: ${p.barcode ?? '—'}\n\n`;
        reply += `Bestand:\n`;
        (stock.results ?? []).forEach((s: any, i: number) => {
          reply += `${i + 1}. ${s.warehouse_name} (${s.code}): ${s.qty_units} Stück\n`;
        });
        return reply;
      }
    }

    if (act === 'summary') {
      if (!checkPerm('/')) return 'Keine Berechtigung';

      const ops = await db.prepare(
        `SELECT COUNT(*) as total, 
                SUM(CASE WHEN status != 'cancelled' THEN 1 ELSE 0 END) as active
         FROM operations WHERE deleted_at IS NULL`
      ).first();

      const partners = await db.prepare(
        `SELECT COUNT(*) as total FROM partners WHERE deleted_at IS NULL`
      ).first();

      const products = await db.prepare(
        `SELECT COUNT(*) as total FROM products WHERE deleted_at IS NULL`
      ).first();

      const o = ops as any;
      const pa = partners as any;
      const pr = products as any;

      return `Zusammenfassung:\n• Operationen: ${o.total} total, ${o.active} aktiv\n• Partner: ${pa.total}\n• Produkte: ${pr.total}`;
    }

    return 'Unbekannte Aktion.';
  } catch (error) {
    console.error('[das-kompanion] Query error:', error);
    return 'Datenbankfehler: ' + (error instanceof Error ? error.message : 'unknown');
  }
}

// ---------------------------------------------------------------------------
// POST /api/chat
// ---------------------------------------------------------------------------
chat.post('/', async (c) => {
  let body: { message?: string; history?: Array<{ role: string; content: string }> };
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, [{ code: 'bad_json', message: 'invalid JSON body' }]);
  }

  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (!message) {
    return fail(c, 400, [{ code: 'empty_message', message: 'message is required' }]);
  }

  // Get user from session token (optional)
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  let user: AuthUser | null = null;

  if (token) {
    user = await validateSession(c.env.DB, token);
  }

  // Default user for anonymous access
  if (!user) {
    user = {
      id: 'anonymous',
      name: 'Gast',
      role: 'support',
      permissions: {
        '/': 'read',
        '/partners': 'read',
        '/operations': 'read',
        '/products': 'read',
        '/warehouses': 'read',
      },
    };
  }

  // Build messages
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...(body.history ?? []),
    { role: 'user', content: message },
  ];

  try {
    // Call LLM
    const text = await callLLM(messages, c.env);

    // Check if response contains a JSON action
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const action = JSON.parse(jsonMatch[0]);
        if (action.action) {
          const result = await executeQuery(action, c.env, user);
          return ok(c, { reply: result });
        }
      } catch {
        // Not valid JSON — treat as regular response
      }
    }

    // Regular text response
    return ok(c, { reply: text });
  } catch (error) {
    console.error('[das-kompanion] Error:', error);
    // Return a helpful error message instead of generic failure
    const errMsg = error instanceof Error ? error.message : 'unknown error';
    return ok(c, { reply: `Entschuldigung, es ist ein Fehler aufgetreten: ${errMsg}` });
  }
});

export default chat;
