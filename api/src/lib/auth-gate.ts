// =============================================================================
// auth-gate — one door for /api/*, instead of 83 doors with optional locks.
//
// Owner 2026-08-03. Measured that day: of 83 route files, 14 checked a session.
// The rest answered anyone who knew the Worker address — 78 partners with tax
// IDs and IBANs, 658 operations, 608 payments, 72 contracts. Nothing was
// breached; nothing was defended either.
//
// The doctrine settles the design. ERP is display and storage; the work is done
// by agents on their own seats. So the ERP has no legitimate machine clients,
// and the correct end state is not an allowlist — it is: a session or nothing.
//
// PUBLIC holds the two paths that cannot require one: the login itself, and the
// health probe that must answer while the login is broken. Anything else that
// shows up in the observe log is not a candidate for the list — it is a leftover
// of the old shape, and the fix is to move it to a seat.
//
// Two modes, one deploy:
//   observe (default) — never blocks, logs every unauthenticated call, so the
//                       leftovers name themselves instead of being guessed at
//   enforce           — 401, no exceptions beyond PUBLIC
//
// Flipping is a variable, not a commit: AUTH_GATE=enforce. Written this way on
// purpose — the day we lock the door should not also be the day we ship new code.
// =============================================================================

import type { Context, Next } from 'hono';
import type { Env } from '../types';
import { validateSession } from './auth';

/** Prefix match. Kept deliberately short — every entry is a permanent hole. */
const PUBLIC = [
  '/api/auth/',        // login, refresh, logout — the door itself
  '/api/_llm-diag',    // provider ping, no data
];

function isPublic(path: string): boolean {
  return PUBLIC.some((p) => path === p.replace(/\/$/, '') || path.startsWith(p));
}

function bearer(c: Context): string | null {
  const header = c.req.header('Authorization');
  const match = header ? /^Bearer\s+(.+)$/i.exec(header) : null;
  return match?.[1]?.trim() || null;
}

export async function authGate(c: Context<{ Bindings: Env }>, next: Next) {
  const path = c.req.path;

  if (!path.startsWith('/api/') || isPublic(path)) return next();

  const token = bearer(c);
  const user = token ? await validateSession(c.env.DB, token) : null;
  if (user) return next();

  const mode = (c.env as unknown as { AUTH_GATE?: string }).AUTH_GATE === 'enforce'
    ? 'enforce'
    : 'observe';

  // The log line is the whole point of observe mode: it turns "who still calls
  // us without a token" from a guess into a list. Never log the token itself.
  console.log(JSON.stringify({
    scope: 'auth-gate',
    mode,
    blocked: mode === 'enforce',
    method: c.req.method,
    path,
    hasToken: !!token,
    ua: c.req.header('User-Agent') || null,
    origin: c.req.header('Origin') || null,
    cf: c.req.header('CF-Connecting-IP') ? 'present' : null,
  }));

  if (mode === 'observe') return next();

  return c.json({
    success: false,
    result: null,
    errors: [{ code: 'unauthorized', message: 'valid session required' }],
    messages: [],
  }, 401);
}
