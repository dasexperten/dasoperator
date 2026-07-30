// Owner 2026-07-30: the Emailer "Ответит агент" button called the shared
// drafting service, whose system prompt names the Owner as the author as a
// constant — so a reply from Lauda's sales@ went out signed "Aram Valeri
// Badalyan". The button now calls the agent's own pen on the agent's own
// Worker: its charter, its memory, its mailbox, its name.
//
// The seat's /mail/draft is not reachable from the browser (it requires the
// service secret and lives on workers.dev, which same-account subrequests
// cannot reach anyway). The API proxies through a service binding, so the
// browser only ever talks to the API and the seats stay closed.

import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { validateSession } from '../lib/auth';
import { MAILBOX_REGISTRY } from '../lib/mailbox-registry';

function bearer(c: import('hono').Context<{ Bindings: Env }>): string | null {
  const h = c.req.header('authorization') || '';
  return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : null;
}

async function requireSession(c: import('hono').Context<{ Bindings: Env }>): Promise<boolean> {
  const token = bearer(c);
  if (!token) return false;
  return !!(await validateSession(c.env.DB, token));
}

const route = new Hono<{ Bindings: Env }>();

/** agent slug → the service binding for that seat. */
const SEAT_BINDING: Record<string, string> = {
  'lauda-briana': 'LAUDA_COMMERCE',
  'roberta-di-maria': 'ROBERTA_CONTENT',
  'julian-farah': 'JULIAN_GEO',
  'alexandra-obnorskaya': 'ALEXANDRA_OBNORSKAYA',
  'tamara-haar': 'TAMARA_HAAR',
  'justina-timber': 'JUSTINA_FINANCE',
  'mina-rutunya': 'MINA_SYSADMIN',
  'marika-nowicka': 'MARIKA_BRAND',
  'maya-krasochkina': 'MAYA_INTELLIGENCE',
  'zina-pevtsova': 'ZINA_LOGISTICS',
  'valentina-korolyeva': 'VALENTINA_LEGAL',
  'lena-sergeeva': 'LENA_ORCHESTRATOR',
  'arina-volkova': 'ARINA_WB',
  'dasha-kozlovskaya': 'DASHA_OZON',
};

/** Which agent owns this mailbox — primary address or a retired alias. */
function ownerOf(address: string) {
  const a = (address || '').trim().toLowerCase();
  return MAILBOX_REGISTRY.find(
    (m) =>
      m.kind === 'agent' &&
      (m.address.toLowerCase() === a ||
        (m.aliases || []).some((x: string) => x.toLowerCase() === a))
  );
}

/**
 * POST /api/email-tasks/agent-draft  { key }
 * key — the archived letter, e.g. Inbox/sales@dasexperten.com/received/....json
 */
route.post('/agent-draft', async (c) => {
  if (!(await requireSession(c))) return fail(c, 401, [{ code: 'unauthorized', message: 'valid session required' }]);

  const body = await c.req.json<{ key?: string }>().catch(() => ({}) as { key?: string });
  const key = (body.key || '').trim();
  if (!key.startsWith('Inbox/')) return fail(c, 400, [{ code: 'bad_key', message: 'key must be an Inbox/... record' }]);

  const mailbox = key.split('/')[1] || '';
  const agent = ownerOf(mailbox);
  if (!agent) return fail(c, 404, [{ code: 'no_owner', message: `no agent owns ${mailbox}` }]);

  const bindingName = SEAT_BINDING[agent.slug || ''];
  const seat = bindingName ? (c.env as unknown as Record<string, Fetcher>)[bindingName] : undefined;
  if (!seat) return fail(c, 502, [{ code: 'no_binding', message: `no worker bound for ${agent.label || agent.slug}` }]);

  const secret = c.env.EMAILER_SERVICE_SECRET;
  if (!secret) return fail(c, 500, [{ code: 'no_secret', message: 'EMAILER_SERVICE_SECRET missing on the API' }]);

  let res: Response;
  try {
    res = await seat.fetch(
      `https://seat/mail/draft?key=${encodeURIComponent(key)}`,
      { headers: { 'X-Emailer-Service-Secret': secret } }
    );
  } catch (err) {
    return fail(c, 502, [{ code: 'seat_unreachable', message: err instanceof Error ? err.message : String(err) }]);
  }

  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    draft?: string;
    by?: string;
    mailbox?: string;
    reason?: string;
  };

  if (!data.ok || !data.draft) {
    // The seat's refusals are deliberate and worth showing verbatim: our own
    // address as sender, a sent record, a draft greeting ourselves.
    return fail(c, 422, [{ code: 'seat_refused', message: data.reason || `seat returned ${res.status}` }]);
  }

  return ok(c, {
    draft: data.draft,
    by: data.by || agent.label,
    agent: agent.label,
    mailbox: data.mailbox || mailbox,
  });
});

export default route;
