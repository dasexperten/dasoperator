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
} from '../lib/wb-reviews';

const app = new Hono<{ Bindings: Env }>();

// -----------------------------------------------------------------------------
// GET /api/reviews/stats — live counts from WB
// -----------------------------------------------------------------------------
app.get('/stats', async (c) => {
  try {
    const counts = await fetchUnansweredCount(c.env);
    return c.json({ ok: true, ...counts });
  } catch (e: any) {
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

export default app;
