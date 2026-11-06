import { Hono } from 'hono';
import type { Env } from '../types';
import { ALARM_PREFIX } from '../lib/diana-alarm';
const route = new Hono<{ Bindings: Env }>();
route.use('*', async (c, next) => {
  const expected = (c.env as unknown as { ERP_RUN_SECRET?: string }).ERP_RUN_SECRET;
  const protocols = (c.req.header('Sec-WebSocket-Protocol') ?? '').split(',').map(s => s.trim());
  const received = (c.req.header('Authorization') ?? '').replace(/^Bearer /, '') || protocols.find(s => s.startsWith('auth.'))?.slice(5);
  if (!expected || received !== expected) return c.json({ ok: false }, 401);
  return next();
});
route.get('/connect', c => {
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') return c.json({ ok: false }, 400);
  const url = new URL(c.req.url); url.pathname = '/connect';
  return c.env.DIANA_WAKE.get(c.env.DIANA_WAKE.idFromName('diana')).fetch(new Request(url, c.req.raw));
});
route.get('/status', c => c.env.DIANA_WAKE.get(c.env.DIANA_WAKE.idFromName('diana')).fetch('https://wake.internal/status'));
route.post('/ack', async c => {
  const body = await c.req.json<{ cid?: string; message_id?: string; at?: string }>();
  if (!body.cid || !body.message_id || !body.at) return c.json({ ok: false }, 400);
  const receipt = await c.env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind('ig_reply:' + body.cid).first<{value:string}>();
  if (!receipt || receipt.value < body.at) return c.json({ ok: false, error: 'diana_receipt_required' }, 409);
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind('diana_message_done:' + body.cid, body.message_id, Date.now()),
    c.env.DB.prepare(`DELETE FROM crm_sync_state WHERE key=?1 AND json_valid(value) AND json_extract(value,'$.message_id')=?2`).bind(ALARM_PREFIX + body.cid, body.message_id),
  ]);
  return c.json({ ok: true });
});
export default route;
