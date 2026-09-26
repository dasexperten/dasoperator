import { Hono } from 'hono';
import type { Env } from '../types';
import { validateSession, type AuthUser } from '../lib/auth';
import { fail, ok } from '../lib/responses';

type Variables = { authUser: AuthUser };
const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  const token = c.req.header('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  const user = token ? await validateSession(c.env.DB, token) : null;
  if (!user) return fail(c, 401, [{ code: 'unauthorized', message: 'Sign in to use WhatsApp.' }]);
  const access = user.permissions['/caller'] || user.permissions['/whatsapp'] || 'none';
  if (user.role !== 'admin' && !['full', 'rw', 'read'].includes(access)) {
    return fail(c, 403, [{ code: 'forbidden', message: 'You do not have access to WhatsApp.' }]);
  }
  c.set('authUser', user);
  return next();
});

function config(env: Env) {
  const baseUrl = env.OPENWA_BASE_URL?.replace(/\/$/, '');
  const apiKey = env.OPENWA_API_KEY;
  const sessionId = env.OPENWA_SESSION_ID;
  return { baseUrl, apiKey, sessionId, configured: Boolean(baseUrl && apiKey && sessionId) };
}

async function jsonOrText(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text.slice(0, 500); }
}

app.get('/status', async (c) => {
  const cfg = config(c.env);
  if (!cfg.configured) return ok(c, { configured: false, gateway: 'not_configured', session: null });
  try {
    const [health, sessions] = await Promise.all([
      fetch(`${cfg.baseUrl}/api/health/ready`, { headers: { Accept: 'application/json' } }),
      fetch(`${cfg.baseUrl}/api/sessions`, { headers: { 'X-API-Key': cfg.apiKey! } }),
    ]);
    const payload = await jsonOrText(sessions);
    const rows = Array.isArray(payload) ? payload : [];
    const session = rows.find((row) => row && typeof row === 'object' && (row as { id?: string }).id === cfg.sessionId) as Record<string, unknown> | undefined;
    return ok(c, {
      configured: true,
      gateway: health.ok ? 'online' : 'offline',
      session: session ? {
        id: session.id,
        name: session.name,
        phone: session.phoneNumber,
        status: session.status,
      } : null,
    });
  } catch {
    return ok(c, { configured: true, gateway: 'offline', session: null });
  }
});

app.get('/messages', async (c) => {
  const raw = Number(c.req.query('limit'));
  const limit = Number.isFinite(raw) ? Math.min(100, Math.max(1, Math.trunc(raw))) : 30;
  const result = await c.env.DB.prepare(`SELECT id, phone, message_text, status,
    provider_message_id, error_message, created_by, created_at, sent_at
    FROM whatsapp_messages ORDER BY created_at DESC LIMIT ?1`).bind(limit).all();
  return ok(c, { messages: result.results, limit });
});

app.post('/send', async (c) => {
  const user = c.get('authUser');
  const access = user.permissions['/caller'] || user.permissions['/whatsapp'] || 'none';
  if (user.role !== 'admin' && !['full', 'rw'].includes(access)) {
    return fail(c, 403, [{ code: 'read_only', message: 'Read/write access is required to send messages.' }]);
  }

  const body = await c.req.json<{ phone?: string; text?: string; idempotency_key?: string; dry_run?: boolean }>().catch(() => ({}));
  const phone = String(body.phone || '').replace(/\D/g, '');
  const text = String(body.text || '').trim();
  if (!/^\d{8,15}$/.test(phone)) return fail(c, 422, [{ code: 'invalid_phone', message: 'Use an international phone number with 8–15 digits.' }]);
  if (!text || text.length > 4096) return fail(c, 422, [{ code: 'invalid_text', message: 'Message must contain 1–4096 characters.' }]);

  const cfg = config(c.env);
  if (!cfg.configured) return fail(c, 503, [{ code: 'not_configured', message: 'WhatsApp gateway is not configured.' }]);
  if (body.dry_run) return ok(c, { valid: true, phone, characters: text.length, session_id: cfg.sessionId });

  const idempotencyKey = String(body.idempotency_key || crypto.randomUUID()).slice(0, 128);
  const existing = await c.env.DB.prepare(`SELECT id, phone, message_text, status, provider_message_id,
    error_message, created_by, created_at, sent_at FROM whatsapp_messages WHERE idempotency_key=?1`).bind(idempotencyKey).first();
  if (existing) return ok(c, existing, ['Duplicate request returned without sending again.']);

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(`INSERT INTO whatsapp_messages
    (id,idempotency_key,phone,message_text,status,created_by,created_at)
    VALUES (?1,?2,?3,?4,'pending',?5,?6)`).bind(id, idempotencyKey, phone, text, user.id, now).run();

  try {
    const response = await fetch(`${cfg.baseUrl}/api/sessions/${encodeURIComponent(cfg.sessionId!)}/messages/send-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': cfg.apiKey! },
      body: JSON.stringify({ chatId: `${phone}@c.us`, text }),
    });
    const provider = await jsonOrText(response) as Record<string, unknown> | null;
    if (!response.ok) throw new Error(`OpenWA returned HTTP ${response.status}`);
    const providerMessageId = typeof provider?.messageId === 'string' ? provider.messageId : null;
    const sentAt = Math.floor(Date.now() / 1000);
    await c.env.DB.prepare(`UPDATE whatsapp_messages SET status='sent', provider_message_id=?1,
      sent_at=?2 WHERE id=?3`).bind(providerMessageId, sentAt, id).run();
    return ok(c, { id, phone, message_text: text, status: 'sent', provider_message_id: providerMessageId, created_by: user.id, created_at: now, sent_at: sentAt });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : 'OpenWA request failed';
    await c.env.DB.prepare(`UPDATE whatsapp_messages SET status='failed', error_message=?1 WHERE id=?2`).bind(message, id).run();
    return fail(c, 502, [{ code: 'send_failed', message }]);
  }
});

export default app;
