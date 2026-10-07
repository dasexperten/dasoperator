// Owner 2026-10-07: every company box is the agent's; the Owner's Gmail is the
// monitor. Each inbound letter is copied to Gmail and archived for the agent.
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = await mkdtemp(join(tmpdir(), 'inbound-monitor-'));
try {
  await build({ entryPoints: ['api/src/lib/email-inbound.ts'], bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'inbound.mjs'), logLevel: 'silent' });
  const { handleInboundEmail } = await import(join(dir, 'inbound.mjs'));
  const mime = (to) => new TextEncoder().encode(`From: Carrier <ops@carrier.example>\r\nTo: ${to}\r\nSubject: Quote\r\nMessage-ID: <q1@carrier.example>\r\nContent-Type: text/plain\r\n\r\nPrice attached.\r\n`);
  const message = (to, failForward = false) => {
    const bytes = mime(to);
    const forwards = [];
    return {
      forwards, from: 'ops@carrier.example', to, rawSize: bytes.length, headers: new Headers({ 'message-id': '<q1@carrier.example>' }),
      raw: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }),
      forward: async (dest) => { forwards.push(dest); if (failForward) throw new Error('forward rejected'); },
    };
  };
  const store = () => {
    const objects = new Map();
    return { objects, get: async k => objects.has(k) ? { text: async () => objects.get(k), json: async () => JSON.parse(objects.get(k)), etag: 'e' } : null, head: async k => objects.has(k) ? { key: k } : null, put: async (k, v) => { objects.set(k, typeof v === 'string' ? v : 'bin'); return {}; }, delete: async k => objects.delete(k), list: async () => ({ objects: [], truncated: false }) };
  };
  const archived = (env, box) => [...env.ARCHIVE.objects.keys()].some(k => k.startsWith(`Inbox/${box}/received/`));
  const log = console.log; console.log = () => {};
  try {
    // Workspace box: Workspace + Gmail copy, and the agent's archive gets it too.
    let env = { ARCHIVE: store(), GOOGLE_WORKSPACE_FORWARD_MAILBOXES: 'logistics@dasexperten.com' };
    let m = message('logistics@dasexperten.com');
    await handleInboundEmail(m, env);
    assert.deepEqual(m.forwards.sort(), ['dasexperten@gmail.com', 'sales@dasexperten.com.test-google-a.com']);
    assert(archived(env, 'logistics@dasexperten.com'), 'workspace box must reach the agent archive');
    // Plain agent box: Gmail copy + archive.
    env = { ARCHIVE: store() };
    m = message('finance@dasexperten.com');
    await handleInboundEmail(m, env);
    assert.deepEqual(m.forwards, ['dasexperten@gmail.com']);
    assert(archived(env, 'finance@dasexperten.com'));
    // A rejected copy never bounces the letter and never costs the agent its archive.
    env = { ARCHIVE: store(), GOOGLE_WORKSPACE_FORWARD_MAILBOXES: 'sales@dasexperten.com' };
    m = message('sales@dasexperten.com', true);
    await handleInboundEmail(m, env);
    assert(archived(env, 'sales@dasexperten.com'));
    // Owner personal box stays Gmail-only: no worker copy, no archive.
    env = { ARCHIVE: store() };
    m = message('dr.badalyan@dasexperten.com');
    await handleInboundEmail(m, env);
    assert.deepEqual(m.forwards, []);
    assert.equal(env.ARCHIVE.objects.size, 0);
  } finally { console.log = log; }
  console.log('PASS: inbound monitor — Gmail copy + agent archive for workspace and plain boxes; copy failure keeps archive; owner box untouched');
} finally { await rm(dir, { recursive: true, force: true }); }
