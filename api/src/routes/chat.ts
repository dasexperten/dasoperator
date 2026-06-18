// =============================================================================
// Das-Kompanion — AI chatbot for ERP (v2 - simplified)
//
// POST /api/chat { message, history? }
//   → { reply }
//
// The chatbot works STRICTLY within the database — no data generation.
// All actions are permission-checked against the user's role.
// =============================================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { callPro } from '../lib/llm';
import { validateSession, type AuthUser } from '../lib/auth';

const chat = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// System prompt — defines Das-Kompanion's behavior
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `Du bist Das-Kompanion, ein KI-Assistent für das Das Experten ERP-System.

DEINE ROLLE:
- Benutzern helfen, die ERP-Datenbank zu verstehen und zu navigieren
- Dokumente, Operationen, Partner, Produkte suchen
- Daten analysieren (Summen, Trends, Status)
- Operationen erstellen (mit Bestätigung)
- Fragen zum Geschäft beantworten

STRENGE REGELN:
1. NIEMALS Daten generieren oder erfinden — nur existierende Daten aus der Datenbank verwenden
2. NIEMALS Dokumente ohne Bestätigung erstellen
3. IMMER Berechtigungen des Benutzers prüfen
4. Im selben antworten wie der Benutzer fragt (Deutsch/Englisch/Russisch)
5. Knapp und professionell antworten
6. Bei Erstellung von Operationen IMMER zuerst bestätigen lassen

WENN DU AUF DATENBANK-ZUGRIFF BRAUCHST:
Antworte mit einer JSON-Struktur wie diese:
{"action": "search", "type": "operations", "query": {"partner_name": "TORI"}}
{"action": "search", "type": "partners", "query": {"name": "Georgia"}}
{"action": "search", "type": "products", "query": {"category": "Toothpaste"}}
{"action": "details", "type": "operation", "id": "abc123"}
{"action": "details", "type": "partner", "id": "xyz789"}
{"action": "summary"}

WICHTIG: Wenn du Daten brauchst, antworte NUR mit dem JSON-Objekt, kein额外 text.
Wenn du keine Daten brauchst, antworte normal in Prosa.

BEISPIELE:
Benutzer: "Zeig mir die letzten Operationen"
Antwort: {"action": "search", "type": "operations", "query": {"limit": 5}}

Benutzer: "Was ist Der.experten?"
Antwort: Das Experten ist eine deutsche Marke für Mundhygieneprodukte...

Benutzer: "Erstelle eine Verkaufsoperation für 100 Einheiten DE201 an TORI"
Antwort: Ich kann die Operation erstellen. Bitte bestätigen Sie:
- Typ: Verkauf
- Partner: TORI
- Produkt: DE201
- Menge: 100

Soll ich die Operation erstellen?`;

// ---------------------------------------------------------------------------
// Execute database queries based on LLM response
// ---------------------------------------------------------------------------
async function executeQuery(
  action: Record<string, unknown>,
  env: Env,
  user: AuthUser,
): Promise<unknown> {
  const db = env.DB;
  const act = action.action as string;
  const type = action.type as string;
  const query = (action.query as Record<string, unknown>) ?? {};
  const id = action.id as string;

  // Permission check
  const checkPerm = (module: string) => {
    if (user.role === 'admin') return true;
    const access = user.permissions[module] ?? 'none';
    return ['full', 'rw', 'read'].includes(access);
  };

  try {
    if (act === 'search') {
      if (type === 'operations') {
        if (!checkPerm('/operations')) return { error: 'Keine Berechtigung für Operationen' };

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
        return { type: 'operations', data: result.results };
      }

      if (type === 'partners') {
        if (!checkPerm('/partners')) return { error: 'Keine Berechtigung für Partner' };

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
        return { type: 'partners', data: result.results };
      }

      if (type === 'products') {
        if (!checkPerm('/products')) return { error: 'Keine Berechtigung für Produkte' };

        let sql = `SELECT id, product_name, invoice_label, category, manufacturer_id 
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
        return { type: 'products', data: result.results };
      }

      if (type === 'documents') {
        if (!checkPerm('/operations')) return { error: 'Keine Berechtigung für Dokumente' };

        let sql = `SELECT d.id, d.document_number, d.document_type, d.document_date, 
                          d.status, d.total_amount, d.currency, o.reference as operation_ref
                   FROM documents d 
                   LEFT JOIN operations o ON o.id = d.operation_id 
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
        return { type: 'documents', data: result.results };
      }
    }

    if (act === 'details') {
      if (type === 'operation') {
        if (!checkPerm('/operations')) return { error: 'Keine Berechtigung für Operationen' };

        const op = await db.prepare(
          `SELECT o.*, p.trade_name as partner_name, c.abbreviation as company
           FROM operations o 
           LEFT JOIN partners p ON p.id = o.partner_id
           LEFT JOIN companies c ON c.id = o.our_company_id
           WHERE o.id = ?`
        ).bind(id).first();

        if (!op) return { error: 'Operation nicht gefunden' };

        const items = await db.prepare(
          `SELECT li.*, pr.product_name
           FROM line_items li
           LEFT JOIN products pr ON pr.id = li.product_id
           WHERE li.operation_id = ?`
        ).bind(id).all();

        return { type: 'operation_detail', operation: op, items: items.results };
      }

      if (type === 'partner') {
        if (!checkPerm('/partners')) return { error: 'Keine Berechtigung für Partner' };

        const partner = await db.prepare(
          `SELECT * FROM partners WHERE id = ?`
        ).bind(id).first();

        if (!partner) return { error: 'Partner nicht gefunden' };

        return { type: 'partner_detail', partner };
      }

      if (type === 'product') {
        if (!checkPerm('/products')) return { error: 'Keine Berechtigung für Produkte' };

        const product = await db.prepare(
          `SELECT p.*, m.name as manufacturer_name
           FROM products p
           LEFT JOIN manufacturers m ON m.id = p.manufacturer_id
           WHERE p.id = ?`
        ).bind(id).first();

        if (!product) return { error: 'Produkt nicht gefunden' };

        const stock = await db.prepare(
          `SELECT s.qty_units, w.name as warehouse_name, w.code
           FROM stocks s
           LEFT JOIN warehouses w ON w.id = s.warehouse_id
           WHERE s.product_id = ?`
        ).bind(id).all();

        return { type: 'product_detail', product, stock: stock.results };
      }
    }

    if (act === 'summary') {
      if (!checkPerm('/')) return { error: 'Keine Berechtigung' };

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

      return {
        type: 'summary',
        operations: ops,
        partners: partners,
        products: products,
      };
    }

    return { error: 'Unbekannte Aktion' };
  } catch (error) {
    console.error('[das-kompanion] Query error:', error);
    return { error: 'Datenbankfehler' };
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

  // Default user for anonymous access (read-only, limited)
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

  // Build messages array for LLM
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...(body.history ?? []),
    { role: 'user', content: message },
  ];

  try {
    // Call LLM
    const result = await callPro(messages, {
      env: c.env,
      maxTokens: 2000,
      temperature: 0.3,
    });

    const text = result.text.trim();

    // Check if response contains a JSON action
    let jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const action = JSON.parse(jsonMatch[0]);
        if (action.action) {
          // Execute the database query
          const queryResult = await executeQuery(action, c.env, user);

          // Format the result for the user
          let formattedReply = '';

          if ((queryResult as Record<string, unknown>).error) {
            formattedReply = (queryResult as Record<string, unknown>).error as string;
          } else {
            const qr = queryResult as Record<string, unknown>;
            const data = qr.data as Array<Record<string, unknown>> | undefined;

            if (qr.type === 'operations' && data) {
              formattedReply = `Gefundene Operationen (${data.length}):\n\n`;
              data.forEach((op, i) => {
                const date = new Date((op.operation_date as number) * 1000).toLocaleDateString('de-DE');
                formattedReply += `${i + 1}. ${op.reference ?? op.id} — ${date} — ${op.partner_name ?? 'Kein Partner'} — ${op.status} — ${op.total_amount} ${op.currency}\n`;
              });
            } else if (qr.type === 'partners' && data) {
              formattedReply = `Gefundene Partner (${data.length}):\n\n`;
              data.forEach((p, i) => {
                formattedReply += `${i + 1}. ${p.trade_name} — ${p.partner_type} — ${p.country ?? 'Kein Land'} — ${p.status}\n`;
              });
            } else if (qr.type === 'products' && data) {
              formattedReply = `Gefundene Produkte (${data.length}):\n\n`;
              data.forEach((p, i) => {
                formattedReply += `${i + 1}. ${p.product_name} — ${p.category}\n`;
              });
            } else if (qr.type === 'documents' && data) {
              formattedReply = `Gefundene Dokumente (${data.length}):\n\n`;
              data.forEach((d, i) => {
                const date = new Date((d.document_date as number) * 1000).toLocaleDateString('de-DE');
                formattedReply += `${i + 1}. ${d.document_number} — ${d.document_type} — ${date} — ${d.status}\n`;
              });
            } else if (qr.type === 'operation_detail') {
              const op = qr.operation as Record<string, unknown>;
              const items = qr.items as Array<Record<string, unknown>>;
              const date = new Date((op.operation_date as number) * 1000).toLocaleDateString('de-DE');
              formattedReply = `Operation: ${op.reference ?? op.id}\n`;
              formattedReply += `Datum: ${date}\n`;
              formattedReply += `Typ: ${op.operation_type}\n`;
              formattedReply += `Partner: ${op.partner_name}\n`;
              formattedReply += `Status: ${op.status}\n`;
              formattedReply += `Betrag: ${op.total_amount} ${op.currency}\n\n`;
              formattedReply += `Positionen:\n`;
              items.forEach((item, i) => {
                formattedReply += `${i + 1}. ${item.product_name} — ${item.qty} × ${item.unit_price} ${item.currency}\n`;
              });
            } else if (qr.type === 'partner_detail') {
              const p = qr.partner as Record<string, unknown>;
              formattedReply = `Partner: ${p.trade_name}\n`;
              formattedReply += `Rechtlicher Name: ${p.legal_name ?? '—'}\n`;
              formattedReply += `Land: ${p.country ?? '—'}\n`;
              formattedReply += `Typ: ${p.partner_type}\n`;
              formattedReply += `Status: ${p.status}\n`;
              formattedReply += `E-Mail: ${p.email ?? '—'}\n`;
            } else if (qr.type === 'product_detail') {
              const p = qr.product as Record<string, unknown>;
              const stock = qr.stock as Array<Record<string, unknown>>;
              formattedReply = `Produkt: ${p.product_name}\n`;
              formattedReply += `Kategorie: ${p.category}\n`;
              formattedReply += `Hersteller: ${p.manufacturer_name}\n`;
              formattedReply += `Barcode: ${p.barcode ?? '—'}\n\n`;
              formattedReply += `Bestand:\n`;
              stock.forEach((s, i) => {
                formattedReply += `${i + 1}. ${s.warehouse_name} (${s.code}): ${s.qty_units} Stück\n`;
              });
            } else if (qr.type === 'summary') {
              const ops = qr.operations as Record<string, unknown>;
              const partners = qr.partners as Record<string, unknown>;
              const products = qr.products as Record<string, unknown>;
              formattedReply = `Zusammenfassung:\n`;
              formattedReply += `• Operationen: ${ops.total} total, ${ops.active} aktiv\n`;
              formattedReply += `• Partner: ${partners.total}\n`;
              formattedReply += `• Produkte: ${products.total}\n`;
            } else {
              formattedReply = JSON.stringify(queryResult, null, 2);
            }
          }

          return ok(c, { reply: formattedReply });
        }
      } catch {
        // Not valid JSON or not an action — treat as regular response
      }
    }

    // Regular text response from LLM
    return ok(c, { reply: text });
  } catch (error) {
    console.error('[das-kompanion] Error:', error);
    return fail(c, 500, [{ code: 'chat_error', message: 'Failed to process chat message' }]);
  }
});

export default chat;
