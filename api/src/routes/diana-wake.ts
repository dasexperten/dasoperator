import { Hono } from 'hono';
import type { Env } from '../types';
import { acknowledgeDianaEvent } from '../lib/diana-alarm';
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
  const body = await c.req.json<{ cid?: string; message_id?: string; event_id?: string }>();
  if (!body.cid || !body.message_id || !body.event_id) return c.json({ ok: false }, 400);
  const ok = await acknowledgeDianaEvent(c.env, {cid:body.cid,message_id:body.message_id,event_id:body.event_id});
  return c.json({ ok }, ok ? 200 : 409);
});
export default route;
