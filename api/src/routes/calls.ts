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

const CHANNELS = new Set(['whatsapp', 'telegram']);

app.get('/', async (c) => {
  const raw = Number(c.req.query('limit'));
  const limit = Number.isFinite(raw) ? Math.min(200, Math.max(1, Math.trunc(raw))) : 100;
  const seat = c.req.query('seat');
  const channel = c.req.query('channel');
  const where: string[] = [];
  const params: unknown[] = [limit];
  if (seat) { params.push(seat); where.push(`seat_slug = ?${params.length}`); }
  if (channel && CHANNELS.has(channel)) { params.push(channel); where.push(`channel = ?${params.length}`); }
  const sql = `SELECT id, seat_slug, seat_name, recipient_phone, recipient_label, call_type, channel, engine, status,
      deal_status, call_purpose, summary, started_at, ended_at, duration_seconds FROM call_transcripts
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC LIMIT ?1`;
  const result = await c.env.DB.prepare(sql).bind(...params).all();
  return ok(c, { calls: result.results, limit });
});

// Owner 2026-09-26: the agent popup lists the last 10 numbers each agent called
// (per channel when one is given). Declared before '/:id' so it is not taken for a call id.
app.get('/agents', async (c) => {
  const channel = c.req.query('channel');
  const byChannel = channel && CHANNELS.has(channel);
  const sql = `SELECT seat_slug, recipient_phone, recipient_label, last_at, calls FROM (
      SELECT seat_slug, recipient_phone, MAX(recipient_label) AS recipient_label, MAX(started_at) AS last_at,
        COUNT(*) AS calls,
        ROW_NUMBER() OVER (PARTITION BY seat_slug ORDER BY MAX(started_at) DESC) AS rn
      FROM call_transcripts ${byChannel ? 'WHERE channel = ?1' : ''}
      GROUP BY seat_slug, recipient_phone
    ) WHERE rn <= 10 ORDER BY seat_slug, last_at DESC`;
  const stmt = c.env.DB.prepare(sql);
  const result = await (byChannel ? stmt.bind(channel) : stmt).all<{
    seat_slug: string; recipient_phone: string; recipient_label: string | null; last_at: number; calls: number;
  }>();
  const agents: Record<string, Array<{ phone: string; label: string | null; last_at: number; calls: number }>> = {};
  for (const row of result.results) {
    (agents[row.seat_slug] ||= []).push({ phone: row.recipient_phone, label: row.recipient_label, last_at: row.last_at, calls: row.calls });
  }
  return ok(c, { agents, channel: byChannel ? channel : null });
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
