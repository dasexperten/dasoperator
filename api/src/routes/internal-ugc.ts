// Owner 2026-10-17: a tap on a Diana hard-question button in Telegram arrives here
// from the organizacia bot (service binding EMAILER, same service secret as mail).
import { Hono } from 'hono';
import type { Env } from '../types';
import { answerHardQuestion } from '../lib/ugc-hard-question';

const route = new Hono<{ Bindings: Env }>();

route.post('/hard-answer', async (c) => {
  c.header('Cache-Control', 'no-store');
  const secret = c.env.EMAILER_SERVICE_SECRET;
  const given = c.req.header('X-Emailer-Service-Secret') ?? '';
  let diff = secret ? secret.length ^ given.length : 1;
  for (let i = 0; secret && i < Math.min(secret.length, given.length); i++) diff |= secret.charCodeAt(i) ^ given.charCodeAt(i);
  if (!secret || diff) return c.json({ ok: false, error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => ({})) as { message_id?: number; choice?: string };
  const messageId = Number(body.message_id);
  const choice = String(body.choice ?? '').trim();
  if (!Number.isFinite(messageId) || !choice) return c.json({ ok: false, error: 'message_id and choice required' }, 400);
  return c.json({ ok: true, ...(await answerHardQuestion(c.env, messageId, choice)) });
});

export default route;
