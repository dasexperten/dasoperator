// =============================================================================
// inventory@dasexperten.com → an inventory session (Owner 2026-09-18).
//
// A warehouse without an API (Saransk) sends its stock list by mail every one or two
// weeks. The letter arrives at worker erp-inventory, which archives it and hands it here.
// DeepSeek V4 Pro reads the list (machine reader, §3j; the Owner asked for the best model) and names the warehouse and, per line,
// the product and the quantity in pieces. The counts become an inventory session through
// the same routes a person uses, so stock moves only by the normal commit.
//
// Commit only when the warehouse is certain and EVERY line is tied to a product.
// Otherwise the session stays open with what was matched, and the Owner gets the lines
// that were not — a wrong count committed silently is worse than a count held for a look.
// =============================================================================
import * as XLSX from 'xlsx';
import PostalMime from 'postal-mime';
import { archiveEmail } from './inbox-archive';
import type { Env } from '../types';
import { callPro } from './deepseek';
import { sendOwnerTelegram } from './owner-telegram';
import inventorySessions from '../routes/inventory-sessions';

export interface InventoryLetter {
  from: string;
  subject: string;
  messageId: string;
  receivedAt?: string | undefined;
  text?: string | undefined;
  html?: string | undefined;
  attachments?: Array<{ filename?: string | undefined; mimeType?: string | undefined; base64: string }>;
}

interface ModelRow {
  source: string;
  product_id: string | null;
  qty_pieces: number | null;
  note?: string;
}
interface ModelOut {
  warehouse_id: string | null;
  warehouse_certain: boolean;
  counted_on?: string | null;
  rows: ModelRow[];
}

const MAX_CHARS = 60_000;

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function stripHtml(html: string): string {
  return html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li)>/gi, '\n').replace(/<\/t[dh]>/gi, '\t').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/[ \t]+\n/g, '\n');
}

/** Everything readable in the letter, as plain text: body, spreadsheets, csv, text files. */
function letterText(l: InventoryLetter): { text: string; skipped: string[] } {
  const parts: string[] = [];
  const skipped: string[] = [];
  const body = (l.text || (l.html ? stripHtml(l.html) : '')).trim();
  if (body) parts.push(`--- письмо ---\n${body}`);
  for (const a of l.attachments ?? []) {
    const name = a.filename || 'attachment';
    const lower = name.toLowerCase();
    try {
      if (/\.(xlsx|xls|ods)$/.test(lower) || /spreadsheet|excel/.test(a.mimeType || '')) {
        const wb = XLSX.read(b64ToBytes(a.base64), { type: 'array' });
        for (const sheet of wb.SheetNames) {
          const ws = wb.Sheets[sheet];
          if (ws) parts.push(`--- ${name} / ${sheet} ---\n${XLSX.utils.sheet_to_csv(ws)}`);
        }
      } else if (/\.(csv|txt|tsv)$/.test(lower) || /^text\//.test(a.mimeType || '')) {
        parts.push(`--- ${name} ---\n${new TextDecoder().decode(b64ToBytes(a.base64))}`);
      } else {
        skipped.push(name);
      }
    } catch (e) {
      skipped.push(`${name} (не прочитан: ${String(e).slice(0, 80)})`);
    }
  }
  return { text: parts.join('\n\n').slice(0, MAX_CHARS), skipped };
}

function parseJson(raw: string): ModelOut {
  const s = raw.replace(/^[\s\S]*?```(?:json)?/i, '').replace(/```[\s\S]*$/, '').trim() || raw;
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  return JSON.parse(s.slice(start, end + 1)) as ModelOut;
}

async function call<T>(env: Env, path: string, method: string, body?: unknown): Promise<T> {
  const res = await inventorySessions.request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env);
  const j = (await res.json()) as { success?: boolean; result?: T; errors?: Array<{ message?: string }> };
  if (!res.ok || j.success === false) throw new Error(`${method} ${path}: ${j.errors?.[0]?.message ?? res.status}`);
  return j.result as T;
}

/** The model step: DeepSeek reads the letter against the live product and warehouse lists. */
export interface InventoryReading { out: ModelOut; skipped: string[] }
export async function readInventoryLetter(
  env: { DB: D1Database; DEEPSEEK_API_KEY?: string },
  l: InventoryLetter,
): Promise<InventoryReading | { empty: true; skipped: string[] }> {
  const { text, skipped } = letterText(l);
  if (!text) return { empty: true, skipped };
  const [products, warehouses] = await Promise.all([
    env.DB.prepare(`SELECT id, product_name, invoice_label_ru, barcode, base_sku, pieces_per_case
                      FROM products WHERE deleted_at IS NULL ORDER BY id`).all(),
    env.DB.prepare(`SELECT id, code, name, city FROM warehouses WHERE deleted_at IS NULL ORDER BY id`).all(),
  ]);
  const system = `Ты разбираешь письмо склада со списком остатков для ERP компании Das Experten.
Верни ТОЛЬКО JSON без пояснений:
{"warehouse_id": "<id склада из списка или null>", "warehouse_certain": true|false,
 "counted_on": "<дата пересчёта YYYY-MM-DD из письма или null>",
 "rows": [{"source": "<строка письма как есть>", "product_id": "<id товара из списка или null>",
           "qty_pieces": <целое число штук или null>, "note": "<почему null, если null>"}]}
Правила:
- Склад и товар выбирай ТОЛЬКО из данных списков. Не уверен — null. Не угадывай.
- Товар узнаётся по артикулу (id, base_sku), штрихкоду или названию. Одно совпадение — ставь; несколько или ни одного — null.
- Количество в ШТУКАХ. Если в строке коробки/короба/кор, умножь на pieces_per_case этого товара и скажи это в note.
- Строки-итоги, заголовки и пустые строки не включай.
- warehouse_certain = true только если склад прямо назван в письме, вложении или адресе отправителя.`;
  const user = `СКЛАДЫ:\n${JSON.stringify(warehouses.results)}\n\nТОВАРЫ:\n${JSON.stringify(products.results)}\n\nОТ: ${l.from}\nТЕМА: ${l.subject}\n\n${text}`;

  // Strongest DeepSeek model (Owner: "the best model for identification"); a letter a week, so cost is no issue.
  const r = await callPro(
    [{ role: 'system', content: system }, { role: 'user', content: user }],
    { apiKey: env.DEEPSEEK_API_KEY as string, maxTokens: 16000, temperature: 0 },
  );
  return { out: parseJson(r.text), skipped };
}

export async function processInventoryLetter(
  env: Env,
  l: InventoryLetter,
  given?: InventoryReading | null,
): Promise<{ status: string; note: string }> {
  const receivedAt = l.receivedAt ?? new Date().toISOString();
  const log = async (row: Record<string, unknown>) => {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO inventory_mail_log
         (received_at, from_addr, subject, message_id, warehouse_id, session_id, reference, status,
          rows_total, rows_matched, unmatched, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      receivedAt, l.from, l.subject, l.messageId,
      row.warehouse_id ?? null, row.session_id ?? null, row.reference ?? null, row.status,
      row.rows_total ?? 0, row.rows_matched ?? 0, row.unmatched ?? null, row.reason ?? null,
    ).run();
  };

  const seen = await env.DB.prepare('SELECT status FROM inventory_mail_log WHERE message_id = ?')
    .bind(l.messageId).first<{ status: string }>();
  if (seen && seen.status !== 'failed') return { status: 'duplicate', note: `letter already handled (${seen.status})` };

  let reading: InventoryReading;
  if (given?.out) {
    reading = given;
  } else {
    let r: Awaited<ReturnType<typeof readInventoryLetter>>;
    try {
      r = await readInventoryLetter(env, l);
    } catch (e) {
      const reason = `DeepSeek не разобрал письмо: ${String(e).slice(0, 200)}`;
      await log({ status: 'failed', reason });
      await sendOwnerTelegram(env, `Инвентаризация по почте: письмо «${l.subject}» не разобрано — модель не ответила. Можно переслать снова.`);
      return { status: 'failed', note: reason };
    }
    if ('empty' in r) {
      const reason = `в письме нечего читать${r.skipped.length ? `; не читаю вложения: ${r.skipped.join(', ')}` : ''}`;
      await log({ status: 'failed', reason });
      await sendOwnerTelegram(env, `Инвентаризация по почте: письмо «${l.subject}» от ${l.from} не разобрано — ${reason}.`);
      return { status: 'failed', note: reason };
    }
    reading = r;
  }
  const out = reading.out;
  const [products, warehouses] = await Promise.all([
    env.DB.prepare('SELECT id FROM products WHERE deleted_at IS NULL').all(),
    env.DB.prepare('SELECT id, name FROM warehouses WHERE deleted_at IS NULL').all(),
  ]);

  const productIds = new Set((products.results as Array<{ id: string }>).map((p) => p.id));
  const warehouseIds = new Map((warehouses.results as Array<{ id: string; name: string }>).map((w) => [w.id, w.name]));
  const warehouseId = out.warehouse_id && warehouseIds.has(out.warehouse_id) ? out.warehouse_id : null;

  // Sum repeats of one product (a list split across sheets); lines without product or qty are unmatched.
  const counts = new Map<string, number>();
  const unmatched: string[] = [];
  for (const r of out.rows ?? []) {
    const ok = r.product_id && productIds.has(r.product_id) && Number.isInteger(r.qty_pieces) && (r.qty_pieces as number) >= 0;
    if (ok) counts.set(r.product_id!, (counts.get(r.product_id!) ?? 0) + (r.qty_pieces as number));
    else unmatched.push(`${r.source}${r.note ? ` — ${r.note}` : ''}`.slice(0, 200));
  }
  const rowsTotal = (out.rows ?? []).length;

  if (!warehouseId || counts.size === 0) {
    const reason = !warehouseId ? 'склад не определён' : 'ни одна строка не привязана к товару';
    await log({ warehouse_id: warehouseId, status: 'held', rows_total: rowsTotal, rows_matched: counts.size,
      unmatched: JSON.stringify(unmatched.slice(0, 50)), reason });
    await sendOwnerTelegram(env, `Инвентаризация по почте: письмо «${l.subject}» — ${reason}. Ничего не проведено.`);
    return { status: 'held', note: reason };
  }

  const whName = warehouseIds.get(warehouseId);
  const session = await call<{ id: string; reference: string }>(env, '/', 'POST', {
    warehouse_id: warehouseId,
    scope: 'partial',
    started_by: 'erp-inventory',
    notes: `По письму на inventory@ от ${l.from}: «${l.subject}»${out.counted_on ? `, пересчёт на ${out.counted_on}` : ''}. Разбор: DeepSeek.`,
  });
  for (const [productId, qty] of counts) {
    const line = await call<{ id: string }>(env, `/${session.id}/lines`, 'POST', { product_id: productId });
    await call(env, `/${session.id}/lines/${line.id}`, 'PATCH', { counted_qty: qty, counted_by: 'erp-inventory' });
  }

  const commit = Boolean(out.warehouse_certain) && unmatched.length === 0;
  let discrepancies = 0;
  if (commit) {
    const c = await call<{ discrepancies?: number }>(env, `/${session.id}/commit`, 'POST', { committed_by: 'erp-inventory' });
    discrepancies = c.discrepancies ?? 0;
  }
  const status = commit ? 'committed' : 'held';
  await log({ warehouse_id: warehouseId, session_id: session.id, reference: session.reference, status,
    rows_total: rowsTotal, rows_matched: counts.size, unmatched: unmatched.length ? JSON.stringify(unmatched.slice(0, 50)) : null,
    reason: commit ? null : (!out.warehouse_certain ? 'склад назван не прямо' : `${unmatched.length} строк без товара`) });

  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const msg = commit
    ? `${whName}: инвентаризация ${session.reference} проведена по письму. Позиций ${counts.size}, всего ${total} шт, расхождений с учётом ${discrepancies}.`
    : `${whName}: инвентаризация ${session.reference} заведена по письму, но НЕ проведена — ${!out.warehouse_certain ? 'склад назван не прямо' : `${unmatched.length} строк не привязаны к товару`}. Привязано ${counts.size}. Проверить в ERP → Склады → Инвентаризации.`;
  await sendOwnerTelegram(env, msg);
  return { status, note: `${session.reference} ${status}: ${counts.size} products, ${total} pcs, unmatched ${unmatched.length}` };
}

export function bytesToB64(buf: ArrayBuffer | Uint8Array | string): string {
  if (typeof buf === 'string') return btoa(unescape(encodeURIComponent(buf)));
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export const INVENTORY_BOX = 'inventory@dasexperten.com';

/** The raw letter from worker erp-inventory: archive it like any inbound mail (§6.4), then read it. */
export async function receiveInventoryMail(env: Env, input: { raw_b64: string; envelope_from?: string; reading?: InventoryReading | null }) {
  const raw = b64ToBytes(input.raw_b64);
  const parsed = await PostalMime.parse(raw);
  const from = parsed.from?.address || input.envelope_from || 'unknown';
  const messageId = parsed.messageId || `inv-${crypto.randomUUID()}`;
  const toList = (parsed.to || []).map((a) => a.address).filter(Boolean) as string[];
  await archiveEmail(env, 'received', INVENTORY_BOX, {
    from,
    to: toList.length ? toList : [INVENTORY_BOX],
    subject: parsed.subject || '(no subject)',
    text: parsed.text || undefined,
    html: parsed.html || undefined,
    messageId,
    origin: 'human',
    attachments: parsed.attachments?.length ? parsed.attachments : undefined,
  });
  return processInventoryLetter(env, {
    from,
    subject: parsed.subject || '(no subject)',
    messageId,
    text: parsed.text || undefined,
    html: parsed.html || undefined,
    attachments: (parsed.attachments ?? []).map((a) => ({
      filename: a.filename ?? undefined,
      mimeType: a.mimeType,
      base64: bytesToB64(a.content as ArrayBuffer),
    })),
  }, input.reading ?? null);
}
