// =============================================================================
// /api/reviews routes (Phase: Reviews v1)
//
// Endpoints for WB review management. Phase 1 — auto-reply tick (manual trigger
// for backlog cleanup + scheduled tick). Phase 2 will add list/draft/approve UI.
// =============================================================================
import { Hono } from 'hono';
import type { Env } from '../types';
import {
  runWbAutoReply,
  fetchUnansweredCount,
  fetchUnansweredList,
  postAnswer,
  draftReply,
  WbRateLimitError,
} from '../lib/wb-reviews';
import { postOzonComment, runOzonDraftPrep } from '../lib/ozon-reviews';

const app = new Hono<{ Bindings: Env }>();

// Channel-aware publish dispatcher: WB reviews use feedbacks-api answer,
// Ozon reviews use the review comment/create endpoint.
async function postReply(env: Env, channel: string | null | undefined, externalId: string, text: string): Promise<void> {
  if ((channel ?? 'wb') === 'ozon') return postOzonComment(env, externalId, text);
  return postAnswer(env, externalId, text);
}


// -----------------------------------------------------------------------------
// GET /api/reviews/stats — live counts from WB, cached in KV for 60s
// Why cache: this endpoint is called repeatedly (by UI polling, by Aram
// curling for status), and each call eats a precious WB request from a tight
// rate-limit budget. Cache lets us peek without paying the WB cost.
// -----------------------------------------------------------------------------
app.get('/stats', async (c) => {
  const CACHE_KEY = 'wb-reviews:stats-cache';
  // Try cache first
  if (c.env.CACHE) {
    const cached = await c.env.CACHE.get(CACHE_KEY, 'json');
    if (cached) {
      return c.json({ ok: true, ...(cached as object), cached: true });
    }
  }
  try {
    const counts = await fetchUnansweredCount(c.env);
    if (c.env.CACHE) {
      await c.env.CACHE.put(CACHE_KEY, JSON.stringify(counts), { expirationTtl: 60 });
    }
    return c.json({ ok: true, ...counts, cached: false });
  } catch (e: any) {
    // If we have a stale cache from earlier, prefer it over an error
    if (c.env.CACHE) {
      const cached = await c.env.CACHE.get('wb-reviews:stats-last-success', 'json');
      if (cached) {
        return c.json({ ok: true, ...(cached as object), cached: true, stale: true });
      }
    }
    return c.json({ ok: false, error: String(e?.message ?? e) }, 502);
  }
});

// -----------------------------------------------------------------------------
// GET /api/reviews/unanswered?take=50&skip=0 — raw list from WB
// (used by /reviews UI in Phase 2)
// -----------------------------------------------------------------------------
app.get('/unanswered', async (c) => {
  const take = Math.min(200, Math.max(1, parseInt(c.req.query('take') ?? '50', 10) || 50));
  const skip = Math.max(0, parseInt(c.req.query('skip') ?? '0', 10) || 0);
  try {
    const feedbacks = await fetchUnansweredList(c.env, take, skip);
    return c.json({ ok: true, count: feedbacks.length, feedbacks });
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.message ?? e) }, 502);
  }
});

// -----------------------------------------------------------------------------
// POST /api/reviews/auto-reply-tick — run one auto-reply cycle
// Body: { maxReplies?: number, maxInspect?: number, pauseMs?: number }
//
// Used by:
//   - Cron `*/10 * * * *` (default maxReplies=10, see scheduled.ts)
//   - Manual cleanup: curl with body { "maxReplies": 100 } to burn backlog
// -----------------------------------------------------------------------------
app.post('/auto-reply-tick', async (c) => {
  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    // empty body is fine — use defaults
  }
  const maxReplies = parseInt(body.maxReplies ?? '5', 10) || 5;
  const maxInspect = parseInt(body.maxInspect ?? '300', 10) || 300;
  const pauseMs = parseInt(body.pauseMs ?? '1200', 10) || 1200;

  try {
    const result = await runWbAutoReply(c.env, { maxReplies, maxInspect, pauseMsBetween: pauseMs });
    return c.json(result);
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.message ?? e) }, 500);
  }
});

// -----------------------------------------------------------------------------
// GET /api/reviews/tick-log — last 50 cron tick results from KV
// Safe to call any number of times — does NOT hit WB API.
// Use this to check if cron is working and what's happening per tick.
// -----------------------------------------------------------------------------
app.get('/tick-log', async (c) => {
  if (!c.env.CACHE) return c.json({ ok: false, error: 'CACHE not bound' }, 500);
  const raw = await c.env.CACHE.get('wb-reviews:tick-log', 'json');
  const history = Array.isArray(raw) ? raw : [];
  return c.json({ ok: true, count: history.length, ticks: history });
});

// -----------------------------------------------------------------------------
// DRAFTS QUEUE — for 1-4 star reviews requiring human approval
// -----------------------------------------------------------------------------

// GET /api/reviews/drafts?status=auto_sent,held,failed&limit=50&channel=wb&rating=5&search=...
// Default — all answered (auto_sent + approved_sent + held + failed), newest first
app.get('/drafts', async (c) => {
  const status = c.req.query('status') ?? 'pending,auto_sent,approved_sent,failed';
  const channel = c.req.query('channel') ?? 'wb';
  const limit = Math.min(200, Math.max(1, parseInt(c.req.query('limit') ?? '50', 10) || 50));
  const offset = Math.max(0, parseInt(c.req.query('offset') ?? '0', 10) || 0);
  const rating = c.req.query('rating'); // optional, exact match
  const search = c.req.query('search'); // searches review_text + draft_text

  const statuses = status.split(',').map(s => s.trim()).filter(Boolean);
  const placeholders = statuses.map(() => '?').join(',');

  const whereExtra: string[] = [];
  const bindExtra: any[] = [];
  if (rating && /^\d+$/.test(rating)) {
    whereExtra.push('rating = ?');
    bindExtra.push(parseInt(rating, 10));
  }
  if (search) {
    whereExtra.push('(review_text LIKE ? OR draft_text LIKE ? OR product_name LIKE ?)');
    const pat = `%${search}%`;
    bindExtra.push(pat, pat, pat);
  }
  const sku = c.req.query('sku'); // canonical base SKU; matches whole product family (DE206, DE206AA, DE206AAAA)
  if (sku) {
    whereExtra.push('LOWER(product_sku) LIKE ?');
    bindExtra.push(`${sku.toLowerCase()}%`);
  }
  const extraWhere = whereExtra.length ? ' AND ' + whereExtra.join(' AND ') : '';

  const result = await c.env.DB.prepare(`
    SELECT id, channel, external_id, rating, customer_name, product_name, product_sku,
           review_text, pros, cons, draft_text, status, approved_by, posted_to_wb_at,
           rejection_reason, short_error, next_attempt_at, created_at, updated_at
    FROM review_drafts
    WHERE channel = ? AND status IN (${placeholders})${extraWhere}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).bind(channel, ...statuses, ...bindExtra, limit, offset).all();

  const counts = await c.env.DB.prepare(`
    SELECT status, COUNT(*) as n FROM review_drafts WHERE channel = ? GROUP BY status
  `).bind(channel).all();

  return c.json({
    ok: true,
    drafts: result.results ?? [],
    counts: (counts.results ?? []).reduce((acc: any, r: any) => { acc[r.status] = r.n; return acc; }, {}),
    limit, offset,
  });
});

// GET /api/reviews/drafts/:id — single draft
app.get('/drafts/:id', async (c) => {
  const id = c.req.param('id');
  const r = await c.env.DB.prepare(
    `SELECT * FROM review_drafts WHERE id = ?`
  ).bind(id).first();
  if (!r) return c.json({ ok: false, error: 'not found' }, 404);
  return c.json({ ok: true, draft: r });
});

// POST /api/reviews/drafts/:id/approve — send the draft to WB
// Body: { approvedBy?: string, editedText?: string }
app.post('/drafts/:id/approve', async (c) => {
  const id = c.req.param('id');
  let body: any = {};
  try { body = await c.req.json(); } catch {}

  const draft = await c.env.DB.prepare(
    `SELECT * FROM review_drafts WHERE id = ? AND status = 'pending'`
  ).bind(id).first<any>();
  if (!draft) return c.json({ ok: false, error: 'not found or not pending' }, 404);

  const textToSend = (body.editedText ?? '').trim() || draft.draft_text;
  if (!textToSend) return c.json({ ok: false, error: 'no text to send' }, 400);

  try {
    await postReply(c.env, draft.channel, draft.external_id, textToSend);
    await c.env.DB.prepare(`
      UPDATE review_drafts
      SET status = 'approved_sent', approved_by = ?, draft_text = ?, posted_to_wb_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).bind(body.approvedBy ?? 'unknown', textToSend, id).run();
    return c.json({ ok: true, status: 'approved_sent' });
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    await c.env.DB.prepare(`
      UPDATE review_drafts SET status = 'failed', rejection_reason = ?, updated_at = datetime('now') WHERE id = ?
    `).bind(`approve failed: ${msg.slice(0, 200)}`, id).run();
    return c.json({ ok: false, error: msg }, 502);
  }
});

// POST /api/reviews/drafts/:id/reject — skip this review (human will reply manually elsewhere)
// Body: { reason?: string, rejectedBy?: string }
app.post('/drafts/:id/reject', async (c) => {
  const id = c.req.param('id');
  let body: any = {};
  try { body = await c.req.json(); } catch {}
  const r = await c.env.DB.prepare(`
    UPDATE review_drafts SET status = 'rejected', rejection_reason = ?, approved_by = ?, updated_at = datetime('now')
    WHERE id = ? AND status = 'pending'
  `).bind(body.reason ?? 'manual skip', body.rejectedBy ?? 'unknown', id).run();
  if (!r.success || (r.meta?.changes ?? 0) === 0) return c.json({ ok: false, error: 'not found or not pending' }, 404);
  return c.json({ ok: true });
});

// POST /api/reviews/drafts/:id/regenerate — ask Claude for a new draft
app.post('/drafts/:id/regenerate', async (c) => {
  const id = c.req.param('id');
  const draft = await c.env.DB.prepare(
    `SELECT * FROM review_drafts WHERE id = ? AND status = 'pending'`
  ).bind(id).first<any>();
  if (!draft) return c.json({ ok: false, error: 'not found or not pending' }, 404);

  // Reconstruct minimal feedback object for draftReply
  const fb: any = {
    id: draft.external_id,
    userName: draft.customer_name,
    productValuation: draft.rating,
    text: draft.review_text,
    pros: draft.pros,
    cons: draft.cons,
    productDetails: { productName: draft.product_name, supplierArticle: draft.product_sku },
  };

  try {
    const newDraft = await draftReply(c.env, fb);
    if (!newDraft.text) throw new Error('empty draft from Claude');
    await c.env.DB.prepare(`
      UPDATE review_drafts SET draft_text = ?, draft_tokens_in = ?, draft_tokens_out = ?, updated_at = datetime('now')
      WHERE id = ?
    `).bind(newDraft.text, newDraft.inputTokens, newDraft.outputTokens, id).run();
    return c.json({ ok: true, draft_text: newDraft.text });
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.message ?? e) }, 500);
  }
});

// POST /api/reviews/drafts/:id/save-text — save edited text WITHOUT publishing
// Used by autosave (debounced 800ms on text change). Does NOT touch WB.
// Body: { text: string }
app.post('/drafts/:id/save-text', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<any>();
  const text = (body.text ?? '').trim();
  if (!text) return c.json({ ok: false, error: 'text required' }, 400);
  const r = await c.env.DB.prepare(`
    UPDATE review_drafts SET draft_text = ?, updated_at = datetime('now')
    WHERE id = ?
  `).bind(text, id).run();
  if ((r.meta?.changes ?? 0) === 0) return c.json({ ok: false, error: 'not found' }, 404);
  return c.json({ ok: true });
});

// POST /api/reviews/drafts/:id/publish — publish (or republish) reply to WB
// Used when user presses Ctrl+Enter after editing. WB overwrites the previous answer.
// Body: { text?: string } — if provided, save then publish; otherwise publish current draft_text.
app.post('/drafts/:id/publish', async (c) => {
  const id = c.req.param('id');
  let body: any = {};
  try { body = await c.req.json(); } catch {}

  const draft = await c.env.DB.prepare(
    `SELECT * FROM review_drafts WHERE id = ?`
  ).bind(id).first<any>();
  if (!draft) return c.json({ ok: false, error: 'not found' }, 404);

  const textToSend = (body.text ?? '').toString().trim() || draft.draft_text;
  if (!textToSend) return c.json({ ok: false, error: 'no text to publish' }, 400);

  try {
    await postReply(c.env, draft.channel, draft.external_id, textToSend);
    await c.env.DB.prepare(`
      UPDATE review_drafts
      SET status = 'approved_sent',
          approved_by = ?,
          draft_text = ?,
          posted_to_wb_at = datetime('now'),
          updated_at = datetime('now'),
          rejection_reason = NULL
      WHERE id = ?
    `).bind('aram', textToSend, id).run();
    return c.json({ ok: true, status: 'approved_sent' });
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    await c.env.DB.prepare(`
      UPDATE review_drafts SET status = 'failed', rejection_reason = ?, updated_at = datetime('now')
      WHERE id = ?
    `).bind(`publish failed: ${msg.slice(0, 200)}`, id).run();
    return c.json({ ok: false, error: msg }, 502);
  }
});

// POST /api/reviews/drafts/:id/release — release a HELD draft (publish to WB)
// Used for 1-2★ replies that were safety-held; user reviewed and approves.
app.post('/drafts/:id/release', async (c) => {
  const id = c.req.param('id');
  const draft = await c.env.DB.prepare(
    `SELECT * FROM review_drafts WHERE id = ? AND status = 'held'`
  ).bind(id).first<any>();
  if (!draft) return c.json({ ok: false, error: 'not found or not held' }, 404);
  if (!draft.draft_text) return c.json({ ok: false, error: 'no text' }, 400);

  try {
    await postReply(c.env, draft.channel, draft.external_id, draft.draft_text);
    await c.env.DB.prepare(`
      UPDATE review_drafts
      SET status = 'approved_sent', approved_by = 'aram', posted_to_wb_at = datetime('now'),
          rejection_reason = NULL, updated_at = datetime('now')
      WHERE id = ?
    `).bind(id).run();
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.message ?? e) }, 502);
  }
});

// POST /api/reviews/drafts/:id/edit (legacy alias) — for existing UI; same as save-text
app.post('/drafts/:id/edit', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<any>();
  const text = (body.text ?? '').trim();
  if (!text) return c.json({ ok: false, error: 'text required' }, 400);
  const r = await c.env.DB.prepare(`
    UPDATE review_drafts SET draft_text = ?, updated_at = datetime('now')
    WHERE id = ?
  `).bind(text, id).run();
  if ((r.meta?.changes ?? 0) === 0) return c.json({ ok: false, error: 'not found' }, 404);
  return c.json({ ok: true });
});

// -----------------------------------------------------------------------------
// GET /api/reviews/products
// Canonical product list grouped by base_sku. Each item shows pretty name +
// total review count across the whole product family (all pack sizes).
//
// SQL strategy: strip trailing 'a' chars from product_sku to derive base.
// Join to products table to get the canonical brand name (e.g. "SYMBIOS").
// -----------------------------------------------------------------------------
app.get('/products', async (c) => {
  const channel = c.req.query('channel') ?? 'wb';

  // 1) Group reviews by base_sku (strip trailing AAAA suffix from product_sku)
  // SQLite: use REPLACE/RTRIM-like trick. We trim trailing 'a' chars from lower(sku).
  // Simplest portable approach: use LIKE join in app code.
  const reviewBuckets = await c.env.DB.prepare(`
    SELECT product_sku, COUNT(*) as cnt
    FROM review_drafts
    WHERE channel = ? AND product_sku IS NOT NULL AND product_sku != ''
    GROUP BY product_sku
  `).bind(channel).all();

  // Aggregate by base_sku in JS (strip trailing 'a' from lowercase id)
  const baseMap: Record<string, { count: number; samples: string[] }> = {};
  for (const row of (reviewBuckets.results ?? []) as Array<{ product_sku: string; cnt: number }>) {
    const raw = String(row.product_sku || '').toLowerCase();
    const base = raw.replace(/a+$/, '');
    if (!base) continue;
    if (!baseMap[base]) baseMap[base] = { count: 0, samples: [] };
    baseMap[base].count += row.cnt;
    baseMap[base].samples.push(raw);
  }

  if (Object.keys(baseMap).length === 0) {
    return c.json({ ok: true, products: [] });
  }

  // 2) Lookup canonical brand names from products table
  const baseSkus = Object.keys(baseMap);
  const placeholders = baseSkus.map(() => '?').join(',');
  const productRows = await c.env.DB.prepare(`
    SELECT id, product_name FROM products WHERE id IN (${placeholders})
  `).bind(...baseSkus).all();
  const nameByBase: Record<string, string> = {};
  for (const r of (productRows.results ?? []) as Array<{ id: string; product_name: string }>) {
    nameByBase[r.id.toLowerCase()] = r.product_name;
  }

  // 3) Build response, sorted by count desc
  const products = baseSkus
    .map((base) => ({
      baseSku: base.toUpperCase(),
      name: nameByBase[base] ?? base.toUpperCase(),
      count: baseMap[base].count,
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return c.json({ ok: true, products });
});

// -----------------------------------------------------------------------------
// POST /api/reviews/reply-all
// Publish ALL pending drafts to Wildberries in one batch.
// Iterates pending → calls postAnswer per item with delay → updates status.
// Returns counters: sent, failed, errors[].
//
// Body: { sku?: string, maxBatch?: number, pauseMs?: number }
//   sku — optional, restrict to one product family
//   maxBatch — safety cap, default 100
//   pauseMs — delay between WB calls, default 1200ms
// -----------------------------------------------------------------------------
app.post('/reply-all', async (c) => {
  let body: any = {};
  try { body = await c.req.json(); } catch {}

  const maxBatch = Math.min(500, Math.max(1, parseInt(body.maxBatch ?? '100', 10) || 100));
  const pauseMs = Math.max(500, parseInt(body.pauseMs ?? '1200', 10) || 1200);
  const sku = (body.sku ?? '').toString().trim().toLowerCase();
  const channel = ((body.channel ?? 'wb').toString().trim().toLowerCase() === 'ozon') ? 'ozon' : 'wb';

  // Fetch pending drafts
  let sql = `
    SELECT id, external_id, draft_text, rating
    FROM review_drafts
    WHERE channel = ? AND status = 'pending'
      AND draft_text IS NOT NULL AND LENGTH(draft_text) > 0
  `;
  const binds: any[] = [channel];
  if (sku) {
    sql += ` AND LOWER(product_sku) LIKE ?`;
    binds.push(`${sku}%`);
  }
  sql += ` ORDER BY created_at ASC LIMIT ?`;
  binds.push(maxBatch);
  const result = await c.env.DB.prepare(sql).bind(...binds).all();
  const drafts = (result.results ?? []) as Array<{ id: string; external_id: string; draft_text: string; rating: number }>;

  if (drafts.length === 0) {
    return c.json({ ok: true, total: 0, sent: 0, failed: 0, errors: [] });
  }

  let sent = 0;
  let failed = 0;
  const errors: Array<{ id: string; error: string }> = [];

  for (const d of drafts) {
    try {
      await postReply(c.env, channel, d.external_id, d.draft_text);
      await c.env.DB.prepare(`
        UPDATE review_drafts
        SET status = 'auto_sent',
            posted_to_wb_at = datetime('now'),
            updated_at = datetime('now'),
            short_error = NULL,
            next_attempt_at = NULL
        WHERE id = ?
      `).bind(d.id).run();
      sent++;
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      failed++;
      // Rate-limit is a soft failure — store retry timestamp so cron can pick it up.
      if (e instanceof WbRateLimitError || msg.includes('429') || msg.toLowerCase().includes('rate limit')) {
        const retryAfterSec = e instanceof WbRateLimitError ? e.retryAfterSec : 3600;
        const nextAttempt = Math.floor(Date.now() / 1000) + retryAfterSec;
        errors.push({ id: d.id, error: `rate_limit: retry in ${retryAfterSec}s` });
        try {
          await c.env.DB.prepare(`
            UPDATE review_drafts
            SET status = 'failed',
                short_error = ?,
                rejection_reason = ?,
                next_attempt_at = ?,
                updated_at = datetime('now')
            WHERE id = ?
          `).bind(
            'wb_rate_limit',
            msg.slice(0, 500),
            nextAttempt,
            d.id,
          ).run();
        } catch {}
        // Stop the batch — WB asked us to wait. Cron will retry.
        break;
      }
      // Hard failure (not rate-limit) — terminal, no auto-retry.
      errors.push({ id: d.id, error: msg.slice(0, 200) });
      try {
        await c.env.DB.prepare(`
          UPDATE review_drafts
          SET status = 'failed',
              short_error = ?,
              rejection_reason = ?,
              next_attempt_at = NULL,
              updated_at = datetime('now')
          WHERE id = ?
        `).bind(
          'wb_error',
          `reply-all: ${msg.slice(0, 500)}`,
          d.id,
        ).run();
      } catch {}
    }
    // Pause between WB calls
    await new Promise((r) => setTimeout(r, pauseMs));
  }

  return c.json({ ok: true, total: drafts.length, sent, failed, errors });
});


// -----------------------------------------------------------------------------
// POST /api/reviews/sweep-retries
// Cron-friendly. Two-step:
//   1. Find review_drafts in status='failed' whose next_attempt_at <= now and
//      short_error='wb_rate_limit' → reset them to 'pending'.
//   2. If anything was reset (or pending already exists), kick off reply-all
//      to drain whatever's ready. WB rate-limit will stop the batch again
//      mid-way — that's fine, next cron tick picks up where this one left off.
//
// Triggered by cron `0 * * * *` (hourly). Safe to call manually.
// -----------------------------------------------------------------------------
app.post('/sweep-retries', async (c) => {
  const now_ts = Math.floor(Date.now() / 1000);

  // Step 1: reset expired rate-limited failures back to pending
  const resetResult = await c.env.DB.prepare(`
    UPDATE review_drafts
    SET status = 'pending',
        next_attempt_at = NULL,
        short_error = NULL,
        rejection_reason = NULL,
        updated_at = datetime('now')
    WHERE channel = 'wb'
      AND status = 'failed'
      AND short_error = 'wb_rate_limit'
      AND next_attempt_at IS NOT NULL
      AND next_attempt_at <= ?
  `).bind(now_ts).run();

  const reset = resetResult.meta?.changes ?? 0;

  // Step 2: count current pending — if zero, nothing to do
  const pendingRow = await c.env.DB.prepare(`
    SELECT COUNT(*) AS n FROM review_drafts
    WHERE channel = 'wb' AND status = 'pending'
      AND draft_text IS NOT NULL AND LENGTH(draft_text) > 0
  `).first<{ n: number }>();
  const pendingCount = pendingRow?.n ?? 0;

  if (pendingCount === 0) {
    return c.json({ ok: true, reset, pending: 0, sent: 0, failed: 0, note: 'nothing to retry' });
  }

  // Step 3: drain up to 50 in this tick. The reply-all loop already handles
  // 429 by breaking + writing next_attempt_at, so we just call its inner logic.
  const drafts = await c.env.DB.prepare(`
    SELECT id, external_id, draft_text, rating
    FROM review_drafts
    WHERE channel = 'wb' AND status = 'pending'
      AND draft_text IS NOT NULL AND LENGTH(draft_text) > 0
    ORDER BY created_at ASC
    LIMIT 50
  `).all<{ id: string; external_id: string; draft_text: string; rating: number }>();

  let sent = 0;
  let failed = 0;
  const errors: Array<{ id: string; error: string }> = [];
  const pauseMs = 1200;

  for (const d of drafts.results ?? []) {
    try {
      await postAnswer(c.env, d.external_id, d.draft_text);
      await c.env.DB.prepare(`
        UPDATE review_drafts
        SET status = 'auto_sent',
            posted_to_wb_at = datetime('now'),
            updated_at = datetime('now'),
            short_error = NULL,
            next_attempt_at = NULL
        WHERE id = ?
      `).bind(d.id).run();
      sent++;
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      failed++;
      if (e instanceof WbRateLimitError || msg.includes('429') || msg.toLowerCase().includes('rate limit')) {
        const retryAfterSec = e instanceof WbRateLimitError ? e.retryAfterSec : 3600;
        const nextAttempt = Math.floor(Date.now() / 1000) + retryAfterSec;
        errors.push({ id: d.id, error: `rate_limit: retry in ${retryAfterSec}s` });
        try {
          await c.env.DB.prepare(`
            UPDATE review_drafts
            SET status = 'failed',
                short_error = ?,
                rejection_reason = ?,
                next_attempt_at = ?,
                updated_at = datetime('now')
            WHERE id = ?
          `).bind('wb_rate_limit', msg.slice(0, 500), nextAttempt, d.id).run();
        } catch {}
        break;
      }
      errors.push({ id: d.id, error: msg.slice(0, 200) });
      try {
        await c.env.DB.prepare(`
          UPDATE review_drafts
          SET status = 'failed',
              short_error = ?,
              rejection_reason = ?,
              next_attempt_at = NULL,
              updated_at = datetime('now')
          WHERE id = ?
        `).bind('wb_error', `sweep: ${msg.slice(0, 500)}`, d.id).run();
      } catch {}
    }
    await new Promise((r) => setTimeout(r, pauseMs));
  }

  return c.json({ ok: true, reset, pending: pendingCount, sent, failed, errors });
});



// -----------------------------------------------------------------------------
// POST /api/reviews/ozon-prep-tick — manual trigger: generate draft replies for
// unprocessed Ozon reviews (same code path as the cron). Does NOT post to Ozon.
// Query: ?max=15 (draft cap), ?inspect=60 (scan cap)
// -----------------------------------------------------------------------------
app.post('/ozon-prep-tick', async (c) => {
  const max = Math.min(50, Math.max(1, parseInt(c.req.query('max') || '15', 10) || 15));
  const inspect = Math.min(200, Math.max(max, parseInt(c.req.query('inspect') || '60', 10) || 60));
  try {
    const r = await runOzonDraftPrep(c.env, { maxDrafts: max, maxInspect: inspect });
    return c.json({ ok: true, ...r });
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.message ?? e) }, 502);
  }
});

export default app;
