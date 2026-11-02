// =============================================================================
// inventory@dasexperten.com → an inventory session (Owner 2026-09-18).
//
// A warehouse without an API (Saransk) sends its stock list by mail every one or two
// weeks. The letter arrives at worker erp-inventory, which archives it and hands it here.
// DeepSeek V4 Pro reads the list (machine reader, §3j; the Owner asked for the best model) and names the warehouse and, per line,
// the product and the quantity in pieces. Mery's fixed spreadsheet is read without the model.
//
// Owner 2026-11-02: every letter starts a match against the ERP at once. A letter never moves
// stock: it may cover only part of a warehouse, and committing it would erase real goods.
// The Owner gets the gaps, a person explains them, and only a person commits a count.
// =============================================================================
import * as XLSX from 'xlsx';
import PostalMime from 'postal-mime';
import { z } from 'zod';
import { archiveEmail } from './inbox-archive';
import type { Env } from '../types';
import { callPro } from './deepseek';
import { sendOwnerTelegram } from './owner-telegram';

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
  note?: string | undefined;
}
interface ModelOut {
  warehouse_id: string | null;
  warehouse_certain: boolean;
  counted_on?: string | null | undefined;
  rows: ModelRow[];
}

const MAX_CHARS = 60_000;
/** This mailbox exists for Saransk (HARD_RULES mail table); its letters name no warehouse. */
const DEFAULT_WAREHOUSE = 'srn';
const MAX_GAPS_IN_MESSAGE = 15;
const MIN_SHEET_LINES = 5;

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

const inventoryReadingSchema = z.object({
  warehouse_id: z.string().nullable(),
  warehouse_certain: z.boolean(),
  counted_on: z.string().nullable().optional(),
  rows: z.array(z.object({
    source: z.string(),
    product_id: z.string().nullable(),
    qty_pieces: z.number().int().nonnegative().safe().nullable(),
    note: z.string().optional(),
  })),
});

export function parseInventoryJson(raw: string): ModelOut {
  const s = raw.replace(/^[\s\S]*?```(?:json)?/i, '').replace(/```[\s\S]*$/, '').trim() || raw;
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  return inventoryReadingSchema.parse(JSON.parse(s.slice(start, end + 1)));
}

/** DE107A4 and "DE119 AA" are Mery's spellings of de107aaaa and de119aa. */
export function normalizeSku(raw: string): string {
  return raw.replace(/\s/g, '').toLowerCase().replace(/a4$/, 'aaaa').replace(/a2$/, 'aa');
}

/**
 * Mery's sheet: an article column, a name column and the total under the last "шт" header.
 * Returns null for any other shape, and the model reads that letter instead.
 */
export function readStockSheet(grid: unknown[][]): ModelRow[] | null {
  const cell = (row: unknown[] | undefined, i: number) => String(row?.[i] ?? '').trim();
  const width = Math.max(0, ...grid.map((r) => r.length));
  let totalCol = -1;
  for (const row of grid.slice(0, 5)) {
    for (let i = 0; i < width; i++) if (cell(row, i).toLowerCase() === 'шт') totalCol = Math.max(totalCol, i);
  }
  const isSku = (v: string) => /^DE\s*\d{3}/i.test(v);
  let skuCol = -1;
  let hits = 0;
  for (let i = 0; i < width; i++) {
    const n = grid.filter((r) => isSku(cell(r, i))).length;
    if (n > hits) { hits = n; skuCol = i; }
  }
  if (totalCol < 0 || hits < MIN_SHEET_LINES) return null;
  const rows: ModelRow[] = [];
  for (const row of grid) {
    const sku = cell(row, skuCol);
    const text = row.slice(skuCol + 1, totalCol).map((v) => String(v ?? '').trim()).find((v) => /[а-яa-z]{3}/i.test(v)) ?? '';
    const qty = Number(cell(row, totalCol));
    if (!cell(row, totalCol) || !Number.isSafeInteger(qty) || qty < 0) continue;
    if (!sku && !text) continue;
    rows.push({ source: `${sku} ${text}`.trim(), product_id: sku ? normalizeSku(sku) : null, qty_pieces: qty,
      ...(sku ? {} : { note: 'нет артикула' }) });
  }
  return rows;
}

function sheetReading(l: InventoryLetter): InventoryReading | null {
  for (const a of l.attachments ?? []) {
    if (!/\.(xlsx|xls)$/i.test(a.filename || '')) continue;
    const wb = XLSX.read(b64ToBytes(a.base64), { type: 'array' });
    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name];
      const rows = ws ? readStockSheet(XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '' })) : null;
      if (rows) return { out: { warehouse_id: DEFAULT_WAREHOUSE, warehouse_certain: false, rows }, skipped: [] };
    }
  }
  return null;
}

/** The model step: DeepSeek reads the letter against the live product and warehouse lists. */
export interface InventoryReading { out: ModelOut; skipped: string[] }
export async function readInventoryLetter(
  env: { DB: D1Database; DEEPSEEK_API_KEY?: string },
  l: InventoryLetter,
): Promise<InventoryReading | { empty: true; skipped: string[] }> {
  const sheet = sheetReading(l);
  if (sheet) return sheet;
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
  // JSON mode prevents free-form output; schema validation prevents strings such
  // as "false" from authorizing a stock commit. Retry malformed output once,
  // against the original letter, before any session or stock mutation.
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await callPro(
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      { apiKey: env.DEEPSEEK_API_KEY as string, maxTokens: 16000, temperature: 0, jsonMode: true },
    );
    try {
      return { out: parseInventoryJson(r.text), skipped };
    } catch {
      if (attempt === 1) throw new Error('Inventory JSON invalid after two readings; no stock written');
    }
  }
  throw new Error('Inventory reading unavailable');
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
      reading = { out: inventoryReadingSchema.parse(given.out), skipped: given.skipped };
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
  const warehouseId = out.warehouse_id && warehouseIds.has(out.warehouse_id) ? out.warehouse_id : DEFAULT_WAREHOUSE;

  // Sum repeats of one product (a list split across sheets); lines without product or qty are unmatched.
  const counts = new Map<string, number>();
  const unmatched: string[] = [];
  for (const r of out.rows ?? []) {
    const ok = r.product_id && productIds.has(r.product_id) && Number.isInteger(r.qty_pieces) && (r.qty_pieces as number) >= 0;
    if (ok) counts.set(r.product_id!, (counts.get(r.product_id!) ?? 0) + (r.qty_pieces as number));
    else unmatched.push(`${r.source}${r.note ? ` — ${r.note}` : ''}`.slice(0, 200));
  }
  const rowsTotal = (out.rows ?? []).length;

  if (counts.size === 0) {
    const reason = 'ни одна строка не привязана к товару';
    await log({ warehouse_id: warehouseId, status: 'held', rows_total: rowsTotal, rows_matched: 0,
      unmatched: JSON.stringify(unmatched.slice(0, 50)), reason });
    await sendOwnerTelegram(env, `Инвентаризация по почте: письмо «${l.subject}» — ${reason}. Сверки нет.`);
    return { status: 'held', note: reason };
  }

  const book = await env.DB.prepare(
    `SELECT product_id, on_hand FROM stocks WHERE warehouse_id = ? AND stock_state = 'on_hand'`,
  ).bind(warehouseId).all();
  const gaps = compareWithBook(counts, book.results as Array<{ product_id: string; on_hand: number }>);
  const whName = warehouseIds.get(warehouseId);
  const reason = `расхождений ${gaps.length}, строк без товара ${unmatched.length}`;
  await log({ warehouse_id: warehouseId, status: 'compared', rows_total: rowsTotal, rows_matched: counts.size,
    unmatched: unmatched.length ? JSON.stringify(unmatched.slice(0, 50)) : null, reason });
  const lines = gaps.slice(0, MAX_GAPS_IN_MESSAGE)
    .map((g) => `${g.product_id}: письмо ${g.counted}, учёт ${g.book}, разница ${g.gap > 0 ? '+' : ''}${g.gap}`);
  const more = gaps.length > lines.length ? `\nЕщё расхождений: ${gaps.length - lines.length}.` : '';
  await sendOwnerTelegram(env, `${whName}: письмо «${l.subject}» сверено с учётом, ${reason}. В учёте ничего не менялось.${lines.length ? `\n${lines.join('\n')}` : ''}${more}`);
  return { status: 'compared', note: `${warehouseId}: ${reason}` };
}

export interface StockGap { product_id: string; counted: number; book: number; gap: number }

/** Every product where the letter and the ERP differ, largest gap first. */
export function compareWithBook(counts: Map<string, number>, book: Array<{ product_id: string; on_hand: number }>): StockGap[] {
  const held = new Map(book.map((r) => [r.product_id, r.on_hand]));
  const gaps: StockGap[] = [];
  for (const id of new Set([...counts.keys(), ...held.keys()])) {
    const counted = counts.get(id) ?? 0;
    const onHand = held.get(id) ?? 0;
    if (counted !== onHand) gaps.push({ product_id: id, counted, book: onHand, gap: counted - onHand });
  }
  return gaps.sort((x, y) => Math.abs(y.gap) - Math.abs(x.gap));
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
