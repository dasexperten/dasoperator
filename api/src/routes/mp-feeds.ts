// =============================================================================
// /api/mp — marketplace feeds ingestion into the shared das_erp_dev D1.
// Ozon reviews  -> review_drafts (channel='ozon')
// Ozon questions-> mp_questions  (channel='ozon')
// WB questions  -> mp_questions  (channel='wb')
// Mirrors the existing WB-reviews ingestion. Manual trigger + cron-friendly.
// =============================================================================
import { Hono } from 'hono';
import type { Env } from '../types';

const app = new Hono<{ Bindings: Env }>();

const WB_BASE = 'https://feedbacks-api.wildberries.ru';
const OZ_BASE = 'https://api-seller.ozon.ru';

function ozHeaders(env: any) {
  return {
    'Client-Id': String(env.OZON_CLIENT_ID),
    'Api-Key': String(env.OZON_API_KEY),
    'Content-Type': 'application/json',
  };
}

async function ensureQuestionsTable(env: any) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS mp_questions (
       id TEXT PRIMARY KEY, channel TEXT NOT NULL, external_id TEXT,
       product_name TEXT, product_sku TEXT, question_text TEXT, answer_text TEXT,
       status TEXT DEFAULT 'pending', customer_name TEXT,
       created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
       UNIQUE(channel, external_id))`
  ).run();
}

async function syncOzonReviews(env: any): Promise<number> {
  let lastId: string | undefined;
  let n = 0, pages = 0;
  do {
    const body: any = { limit: 100, sort_dir: 'DESC', status: 'ALL' };
    if (lastId) body.last_id = lastId;
    const r = await fetch(`${OZ_BASE}/v1/review/list`, { method: 'POST', headers: ozHeaders(env), body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`Ozon reviews ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j: any = await r.json();
    const reviews: any[] = j.reviews || [];
    for (const rv of reviews) {
      await env.DB.prepare(
        `INSERT INTO review_drafts (id, channel, external_id, rating, product_sku, review_text, status, created_at, updated_at)
         VALUES (?, 'ozon', ?, ?, ?, ?, 'pending', ?, datetime('now'))
         ON CONFLICT(channel, external_id) DO UPDATE SET rating=excluded.rating, review_text=excluded.review_text, updated_at=datetime('now')`
      ).bind('oz_' + rv.id, String(rv.id), Number(rv.rating) || 0, String(rv.sku || ''), rv.text || '', rv.published_at || new Date().toISOString()).run();
      n++;
    }
    lastId = j.has_next ? j.last_id : undefined;
    pages++;
  } while (lastId && pages < 40);
  return n;
}

async function syncOzonQuestions(env: any): Promise<number> {
  const r = await fetch(`${OZ_BASE}/v1/question/list`, { method: 'POST', headers: ozHeaders(env), body: JSON.stringify({}) });
  if (!r.ok) throw new Error(`Ozon questions ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j: any = await r.json();
  const qs: any[] = j.questions || [];
  let n = 0;
  for (const q of qs) {
    await env.DB.prepare(
      `INSERT INTO mp_questions (id, channel, external_id, product_sku, question_text, customer_name, status, created_at, updated_at)
       VALUES (?, 'ozon', ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(channel, external_id) DO UPDATE SET question_text=excluded.question_text, status=excluded.status, updated_at=datetime('now')`
    ).bind('ozq_' + q.id, String(q.id), String(q.sku || ''), q.text || '', q.author_name || null, (q.answers_count > 0 ? 'answered' : 'pending'), q.published_at || new Date().toISOString()).run();
    n++;
  }
  return n;
}

async function syncWbQuestions(env: any): Promise<number> {
  let n = 0;
  for (const answered of [false, true]) {
    const url = `${WB_BASE}/api/v1/questions?isAnswered=${answered}&take=100&skip=0&order=dateDesc`;
    const r = await fetch(url, { headers: { Authorization: env.WB_API_TOKEN_REVIEWS } });
    if (!r.ok) continue;
    const j: any = await r.json();
    const qs: any[] = (j.data && j.data.questions) || [];
    for (const q of qs) {
      const pd = q.productDetails || {};
      await env.DB.prepare(
        `INSERT INTO mp_questions (id, channel, external_id, product_name, product_sku, question_text, answer_text, status, created_at, updated_at)
         VALUES (?, 'wb', ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(channel, external_id) DO UPDATE SET answer_text=excluded.answer_text, status=excluded.status, updated_at=datetime('now')`
      ).bind('wbq_' + q.id, String(q.id), pd.productName || null, pd.supplierArticle || null, q.text || '', (q.answer && q.answer.text) || null, (answered ? 'answered' : 'pending'), q.createdDate || new Date().toISOString()).run();
      n++;
    }
  }
  return n;
}

app.post('/sync-ozon-reviews', async (c) => {
  try { return c.json({ ok: true, upserted: await syncOzonReviews(c.env as any) }); }
  catch (e: any) { return c.json({ ok: false, error: String(e?.message ?? e) }, 502); }
});
app.post('/sync-ozon-questions', async (c) => {
  await ensureQuestionsTable(c.env as any);
  try { return c.json({ ok: true, upserted: await syncOzonQuestions(c.env as any) }); }
  catch (e: any) { return c.json({ ok: false, error: String(e?.message ?? e) }, 502); }
});
app.post('/sync-wb-questions', async (c) => {
  await ensureQuestionsTable(c.env as any);
  try { return c.json({ ok: true, upserted: await syncWbQuestions(c.env as any) }); }
  catch (e: any) { return c.json({ ok: false, error: String(e?.message ?? e) }, 502); }
});
app.post('/sync-all', async (c) => {
  const env = c.env as any;
  await ensureQuestionsTable(env);
  const out: any = {};
  try { out.ozon_reviews = await syncOzonReviews(env); } catch (e: any) { out.ozon_reviews_error = String(e?.message ?? e); }
  try { out.ozon_questions = await syncOzonQuestions(env); } catch (e: any) { out.ozon_questions_error = String(e?.message ?? e); }
  try { out.wb_questions = await syncWbQuestions(env); } catch (e: any) { out.wb_questions_error = String(e?.message ?? e); }
  return c.json({ ok: true, ...out });
});

app.get('/questions', async (c) => {
  const env = c.env as any;
  const channel = c.req.query('channel') || 'wb';
  const limit = Math.min(200, Math.max(1, parseInt(c.req.query('limit') || '50', 10) || 50));
  await ensureQuestionsTable(env);
  const res = await env.DB.prepare(
    `SELECT id, channel, external_id, product_name, product_sku, question_text, answer_text, status, customer_name, created_at
     FROM mp_questions WHERE channel = ? ORDER BY created_at DESC LIMIT ?`
  ).bind(channel, limit).all();
  return c.json({ ok: true, channel, questions: res.results || [] });
});

export default app;
