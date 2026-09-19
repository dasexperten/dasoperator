import { Hono } from 'hono';
import type { Env } from '../types';
import { validateSession } from '../lib/auth';

// Display only: Tamara owns composition and delivery. Never expose reply_sign.
const app = new Hono<{ Bindings: Env }>();
app.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  const token = c.req.header('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  const user = token ? await validateSession(c.env.DB, token) : null;
  if (!user) return c.json({ error: 'Sign in to view customer chats.' }, 401);
  if (user.role !== 'admin' && !['full', 'rw', 'read'].includes(user.permissions['/reviews'] || 'none')) {
    return c.json({ error: 'You do not have access to customer chats.' }, 403);
  }
  return next();
});

const number = (value: string | undefined, fallback: number, max: number) =>
  Math.min(max, Math.max(0, Math.trunc(Number(value) || fallback)));

app.get('/', async (c) => {
  const channel = c.req.query('channel');
  if (channel !== 'wb' && channel !== 'ozon') return c.json({ error: 'Choose WB or Ozon.' }, 400);
  const limit = Math.max(1, number(c.req.query('limit'), 30, 100));
  const offset = number(c.req.query('offset'), 0, 1000000);
  const search = (c.req.query('search') || '').trim().slice(0, 200);
  const where = `t.channel = ? ${search ? `AND (t.buyer_name LIKE ? OR t.product_name LIKE ? OR t.external_chat_id LIKE ? OR EXISTS (SELECT 1 FROM care_chat_messages m WHERE m.thread_id=t.id AND m.text LIKE ?))` : ''}`;
  const params = search ? [channel, ...Array(4).fill(`%${search}%`)] : [channel];
  try {
    const results = await c.env.DB.batch([
      c.env.DB.prepare(`SELECT t.id, t.channel, t.external_chat_id, t.status, t.buyer_name,
        t.product_name, t.sku, t.last_buyer_at, t.last_seller_at, t.updated_at,
        (SELECT text FROM care_chat_messages WHERE thread_id=t.id ORDER BY datetime(created_at) DESC, id DESC LIMIT 1) AS latest_text,
        (SELECT status FROM care_chat_replies WHERE thread_id=t.id ORDER BY datetime(created_at) DESC, id DESC LIMIT 1) AS reply_status
        FROM care_chat_threads t WHERE ${where}
        ORDER BY t.last_buyer_at IS NULL, datetime(COALESCE(t.last_buyer_at,t.updated_at)) DESC, t.id DESC LIMIT ? OFFSET ?`).bind(...params, limit, offset),
      c.env.DB.prepare(`SELECT COUNT(*) AS total FROM care_chat_threads t WHERE ${where}`).bind(...params),
      c.env.DB.prepare(`SELECT status, rows_synced, started_at, finished_at FROM care_chat_sync_log
        WHERE marketplace=? ORDER BY id DESC LIMIT 1`).bind(`${channel}-chats`),
      c.env.DB.prepare(`SELECT rows_synced, finished_at FROM care_chat_sync_log
        WHERE marketplace=? AND status='ok' ORDER BY id DESC LIMIT 1`).bind(`${channel}-chats`),
    ]);
    return c.json({ threads: results[0]!.results, total: (results[1]!.results[0] as { total: number } | undefined)?.total || 0,
      sync: results[2]!.results[0] || null, last_success: results[3]!.results[0] || null, limit, offset });
  } catch {
    return c.json({ error: 'Chat data is unavailable. Try refreshing shortly.' }, 503);
  }
});

app.get('/:id', async (c) => {
  const id = c.req.param('id');
  const offset = number(c.req.query('offset'), 0, 1000000);
  const limit = 100;
  try {
    const thread = await c.env.DB.prepare(`SELECT id, channel, external_chat_id, buyer_name,
      product_name, sku, status, last_buyer_at, last_seller_at FROM care_chat_threads WHERE id=?`).bind(id).first();
    if (!thread) return c.json({ error: 'Conversation not found.' }, 404);
    const result = await c.env.DB.batch([
      c.env.DB.prepare(`SELECT id, sender, msg_type, text, created_at FROM care_chat_messages
        WHERE thread_id=? ORDER BY datetime(created_at), id LIMIT ? OFFSET ?`).bind(id, limit + 1, offset),
      c.env.DB.prepare(`SELECT id, text, status, created_at, sent_at, external_msg_id FROM care_chat_replies
        WHERE thread_id=? ORDER BY datetime(created_at), id`).bind(id),
    ]);
    return c.json({ thread, messages: result[0]!.results.slice(0, limit), replies: result[1]!.results,
      next_offset: result[0]!.results.length > limit ? offset + limit : null });
  } catch {
    return c.json({ error: 'Conversation is unavailable. Try refreshing shortly.' }, 503);
  }
});

export default app;
