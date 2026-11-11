import { Hono } from 'hono';
import type { Env } from '../types';
import { validSignature, extractShares, saveShares } from '../lib/ig-share-webhook.mjs';

// Owner 2026-11-11: Meta's Instagram messaging webhook for app DasWA. Public path
// (outside /api), but every delivery must carry DasWA's signature. It only records
// the links of forwarded reels and posts; Diana's polling, replies and payouts are
// untouched and keep working if this route is silent.
const app = new Hono<{ Bindings: Env }>();

app.get('/', (c) => {
  const mode = c.req.query('hub.mode'), token = c.req.query('hub.verify_token'), challenge = c.req.query('hub.challenge');
  const expected = c.env.META_IG_VERIFY_TOKEN ?? '';
  if (mode === 'subscribe' && expected && token === expected && challenge) return c.text(challenge);
  return c.text('forbidden', 403);
});

app.post('/', async (c) => {
  const raw = await c.req.text();
  if (!await validSignature(raw, c.req.header('x-hub-signature-256') ?? '', c.env.META_IG_APP_SECRET ?? '')) return c.text('bad signature', 401);
  let payload: unknown = null;
  try { payload = JSON.parse(raw); } catch { return c.text('ok'); }
  const shares = extractShares(payload);
  if (shares.length) await saveShares(c.env.DB, shares);
  // Keep a short sample of unseen formats so the first real reel can be checked by hand.
  try {
    const kinds = JSON.stringify(payload).match(/"type":"[a-z_]+"/g)?.slice(0, 5) ?? [];
    await c.env.DB.prepare("INSERT INTO crm_sync_state(key,value,updated_at) VALUES('ig_webhook_last',?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
      .bind(JSON.stringify({ at: Date.now(), shares: shares.length, kinds }), Date.now()).run();
  } catch { /* diagnostics only */ }
  return c.text('ok');
});

export default app;
