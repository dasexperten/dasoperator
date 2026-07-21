// =============================================================================
// Ozon discount-request approval workflow (Tamara care lane).
//
// Owner 2026-07-21: buyer discount requests ("Хочу скидку" on the PDP) are a
// pre-purchase conversion moment. Every morning the worker pulls NEW
// discounts-task items from the Ozon Seller API, approves them within the care
// law (default counter 5%, hard cap 6% — CARE_DISCOUNT_POLICY.md), and attaches
// a short seller comment written to raise the chance of purchase: a warm line,
// one true product angle, the discount grant, and a fair-review invite.
//
// Guardrails:
//   - Grant = 5% off the task's base price (env OZON_DISCOUNT_GRANT, default
//     0.05). If the buyer asked for LESS than the grant, approve at their price.
//   - Never approve below the 6% cap (env OZON_DISCOUNT_CAP, default 0.06).
//     A request deeper than the cap is countered at the grant price, not
//     declined — the buyer can still accept the smaller discount.
//   - If the task carries a min price and the counter would fall below
//     0.8 × min (Dasha's action-price floor law), the task is left untouched
//     and marked 'escalated' for Justina → Owner.
//   - KV CACHE key 'ozon-discounts:cron-paused' = 1 pauses the cron (same
//     pattern as wb-reviews:cron-paused).
//
// Credentials: Tamara lane (TAMARA_OZON_API_KEY → legacy OZON_API_KEY). The
// key must carry the Ozon role for /v1/actions/discounts-task/* — if it does
// not, the run logs an error row in marketplace_sync_log ('ozon-discounts').
// =============================================================================

import type { Env } from '../types';
import { ozonHeadersForTamara } from './tamara-marketplace-creds';

const OZ_BASE = 'https://api-seller.ozon.ru';

interface OzonDiscountTask {
  id: number;
  created_at: string;
  end_at?: string;
  sku?: number;
  offer_id?: string;
  base_price?: number;
  price?: number;
  min_auto_price?: number;
  minimum_price?: number;
  requested_price?: number;
  requested_discount_percent?: number;
  requested_quantity_min?: number;
  requested_quantity_max?: number;
  [k: string]: unknown;
}

// Conversion comments: warm + one product angle + the grant + fair-review
// invite. Rotated per task so batches do not read machine-stamped. Kept under
// Ozon's comment length budget.
const COMMENT_TEMPLATES: string[] = [
  'Здравствуйте! Спасибо, что выбираете Das Experten — приятно, что продукт вам интересен. Делаем вам персональную скидку {pct}%. Формулы у нас профессиональные, немецкая рецептура — разница чувствуется с первых применений. Будем рады честному отзыву после покупки!',
  'Добрый день! С удовольствием идём навстречу — ваша скидка {pct}% уже одобрена. Этот продукт один из самых любимых у наших покупателей: работает деликатно и заметно. После знакомства с ним будем благодарны за справедливый отзыв.',
  'Здравствуйте! Одобрили вам скидку {pct}% — пусть знакомство с Das Experten будет приятным. Внутри — профессиональный уход, каким пользуются стоматологи. Поделитесь потом честным впечатлением в отзыве — нам это очень помогает.',
];

function buildComment(idx: number, pctOff: number): string {
  const t = COMMENT_TEMPLATES[idx % COMMENT_TEMPLATES.length];
  return t.replace('{pct}', String(Math.round(pctOff * 100)));
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface DiscountRunResult {
  paused: boolean;
  fetched: number;
  approved: number;
  escalated: number;
  errors: string[];
}

export async function runOzonDiscountTasks(env: Env): Promise<DiscountRunResult> {
  const out: DiscountRunResult = { paused: false, fetched: 0, approved: 0, escalated: 0, errors: [] };

  const paused = await env.CACHE.get('ozon-discounts:cron-paused');
  if (paused && paused !== '0') {
    console.log('[ozon-discounts] paused via KV ozon-discounts:cron-paused — skipping');
    out.paused = true;
    return out;
  }

  const started = Math.floor(Date.now() / 1000);
  const logRes = await env.DB.prepare(
    "INSERT INTO marketplace_sync_log (marketplace, started_at, status) VALUES ('ozon-discounts', ?, 'running')"
  ).bind(started).run();
  const logId = logRes.meta.last_row_id as number;

  try {
    const grant = Math.min(Number(env.OZON_DISCOUNT_GRANT) || 0.05, 0.06);
    const cap = Math.min(Number(env.OZON_DISCOUNT_CAP) || 0.06, 0.10);
    const headers = ozonHeadersForTamara(env);

    // Pull NEW tasks (paginated).
    const tasks: OzonDiscountTask[] = [];
    let page = 1;
    while (page <= 10) {
      const r = await fetch(`${OZ_BASE}/v1/actions/discounts-task/list`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ status: 'NEW', page, limit: 50 }),
      });
      if (!r.ok) throw new Error(`discounts-task/list HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
      const body = (await r.json()) as { result?: OzonDiscountTask[] };
      const chunk = body.result ?? [];
      tasks.push(...chunk);
      if (chunk.length < 50) break;
      page++;
    }
    out.fetched = tasks.length;

    let idx = 0;
    for (const t of tasks) {
      idx++;
      const basePrice = num(t.base_price) ?? num(t.price);
      const requested = num(t.requested_price);
      const minPrice = num(t.min_auto_price) ?? num(t.minimum_price);
      if (!basePrice) {
        out.errors.push(`task ${t.id}: no base price in payload — skipped`);
        continue;
      }

      // Counter price: 5% off, but if the buyer asked for a SMALLER discount,
      // give exactly what they asked. Never deeper than the cap.
      const grantPrice = Math.round(basePrice * (1 - grant));
      const capPrice = Math.round(basePrice * (1 - cap));
      let approvedPrice = grantPrice;
      if (requested && requested > grantPrice) approvedPrice = Math.round(requested);
      if (approvedPrice < capPrice) approvedPrice = grantPrice;

      // Dasha's floor law: action price never below 0.8 × min.
      if (minPrice && approvedPrice < minPrice * 0.8) {
        out.escalated++;
        await recordTask(env, t, null, 'escalated', 'below 0.8×min floor — Justina → Owner');
        continue;
      }

      const pctOff = (basePrice - approvedPrice) / basePrice;
      const comment = buildComment(idx, pctOff);
      const qtyMin = num(t.requested_quantity_min) ?? 1;
      const qtyMax = num(t.requested_quantity_max) ?? qtyMin;

      const ar = await fetch(`${OZ_BASE}/v1/actions/discounts-task/approve`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          tasks: [{
            id: t.id,
            approved_price: approvedPrice,
            approved_quantity_min: qtyMin,
            approved_quantity_max: qtyMax,
            seller_comment: comment,
          }],
        }),
      });
      if (!ar.ok) {
        out.errors.push(`task ${t.id}: approve HTTP ${ar.status}: ${(await ar.text()).slice(0, 200)}`);
        continue;
      }
      out.approved++;
      await recordTask(env, t, approvedPrice, 'approved', comment);
      // Ozon seller-api budget ~2 req/s — keep gentle spacing.
      await new Promise((res) => setTimeout(res, 600));
    }

    await env.DB.prepare(
      "UPDATE marketplace_sync_log SET finished_at = ?, status = 'ok', rows_synced = ? WHERE id = ?"
    ).bind(Math.floor(Date.now() / 1000), out.approved, logId).run();
  } catch (e: any) {
    const msg = String(e?.message || e);
    out.errors.push(msg);
    await env.DB.prepare(
      "UPDATE marketplace_sync_log SET finished_at = ?, status = 'error', error_message = ? WHERE id = ?"
    ).bind(Math.floor(Date.now() / 1000), msg.slice(0, 500), logId).run();
  }
  return out;
}

async function recordTask(
  env: Env,
  t: OzonDiscountTask,
  approvedPrice: number | null,
  action: 'approved' | 'escalated',
  comment: string,
): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO ozon_discount_tasks
      (task_id, offer_id, sku, base_price, requested_price, approved_price, action, seller_comment, processed_at, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id) DO UPDATE SET
      approved_price = excluded.approved_price,
      action = excluded.action,
      seller_comment = excluded.seller_comment,
      processed_at = excluded.processed_at
  `).bind(
    t.id,
    t.offer_id ?? null,
    t.sku ?? null,
    num(t.base_price) ?? num(t.price),
    num(t.requested_price),
    approvedPrice,
    action,
    comment.slice(0, 600),
    Math.floor(Date.now() / 1000),
    JSON.stringify(t).slice(0, 4000),
  ).run();
}
