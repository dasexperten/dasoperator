import { Hono } from 'hono';
import type { Env } from '../types';
import { validateSession, type AuthUser } from '../lib/auth';
import { fail, ok } from '../lib/responses';

// Caller (Owner 2026-09-26): every agent's voice call with its transcript, under Emailer.
// Read-only: ERP displays and stores (auth-gate doctrine, Owner 2026-08-03 — no machine
// clients). The WhatsApp voice bridge writes rows straight into D1 table call_transcripts.

type Variables = { authUser: AuthUser };
const app = new Hono<{ Bindings: Env; Variables: Variables }>();

interface TranscriptTurn { speaker: 'agent' | 'recipient'; text: string; at?: number }

app.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  const token = c.req.header('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  const user = token ? await validateSession(c.env.DB, token) : null;
  if (!user) return fail(c, 401, [{ code: 'unauthorized', message: 'Sign in to use Caller.' }]);
  // Caller replaced WhatsApp (Owner 2026-09-26): an existing WhatsApp grant opens it.
  const access = user.permissions['/caller'] || user.permissions['/whatsapp'] || 'none';
  if (user.role !== 'admin' && !['full', 'rw', 'read'].includes(access)) {
    return fail(c, 403, [{ code: 'forbidden', message: 'You do not have access to Caller.' }]);
  }
  c.set('authUser', user);
  return next();
});

app.get('/', async (c) => {
  const raw = Number(c.req.query('limit'));
  const limit = Number.isFinite(raw) ? Math.min(200, Math.max(1, Math.trunc(raw))) : 100;
  const seat = c.req.query('seat');
  const sql = `SELECT id, seat_slug, seat_name, recipient_phone, recipient_label, call_type, channel, engine, status,
      deal_status, call_purpose, summary, started_at, ended_at, duration_seconds FROM call_transcripts
    ${seat ? 'WHERE seat_slug = ?2' : ''} ORDER BY started_at DESC LIMIT ?1`;
  const stmt = c.env.DB.prepare(sql);
  const result = await (seat ? stmt.bind(limit, seat) : stmt.bind(limit)).all();
  return ok(c, { calls: result.results, limit });
});

app.get('/:id', async (c) => {
  const row = await c.env.DB.prepare(`SELECT * FROM call_transcripts WHERE id = ?1`).bind(c.req.param('id')).first<Record<string, unknown>>();
  if (!row) return fail(c, 404, [{ code: 'not_found', message: 'Call not found.' }]);
  let transcript: TranscriptTurn[] = [];
  try { transcript = JSON.parse(String(row.transcript_json || '[]')); } catch { transcript = []; }
  const { transcript_json: _omit, ...call } = row;
  return ok(c, { call, transcript });
});

export default app;
