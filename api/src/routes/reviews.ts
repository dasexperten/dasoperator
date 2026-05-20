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
} from '../lib/wb-reviews';

const app = new Hono<{ Bindings: Env }>();

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

// GET /api/reviews/drafts?status=pending&limit=50&channel=wb
app.get('/drafts', async (c) => {
  const status = c.req.query('status') ?? 'pending';
  const channel = c.req.query('channel') ?? 'wb';
  const limit = Math.min(200, Math.max(1, parseInt(c.req.query('limit') ?? '50', 10) || 50));
  const offset = Math.max(0, parseInt(c.req.query('offset') ?? '0', 10) || 0);

  // status can be comma-separated for multi-filter
  const statuses = status.split(',').map(s => s.trim()).filter(Boolean);
  const placeholders = statuses.map(() => '?').join(',');

  const result = await c.env.DB.prepare(`
    SELECT id, channel, external_id, rating, customer_name, product_name, product_sku,
           review_text, pros, cons, draft_text, status, approved_by, posted_to_wb_at,
           rejection_reason, created_at, updated_at
    FROM review_drafts
    WHERE channel = ? AND status IN (${placeholders})
    ORDER BY rating ASC, created_at DESC
    LIMIT ? OFFSET ?
  `).bind(channel, ...statuses, limit, offset).all();

  // Counts per status for UI badges
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
    await postAnswer(c.env, draft.external_id, textToSend);
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

// POST /api/reviews/drafts/:id/edit — save edited text without sending
// Body: { text: string }
app.post('/drafts/:id/edit', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<any>();
  const text = (body.text ?? '').trim();
  if (!text) return c.json({ ok: false, error: 'text required' }, 400);
  const r = await c.env.DB.prepare(`
    UPDATE review_drafts SET draft_text = ?, updated_at = datetime('now')
    WHERE id = ? AND status = 'pending'
  `).bind(text, id).run();
  if ((r.meta?.changes ?? 0) === 0) return c.json({ ok: false, error: 'not found or not pending' }, 404);
  return c.json({ ok: true });
});

export default app;
