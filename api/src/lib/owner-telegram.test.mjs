// Owner 2026-09-19: bot delivery must not fall back to Saved Messages.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';

const dir = mkdtempSync(join(tmpdir(), 'owner-tg-'));
function compile(relative, name) {
  const outfile = join(dir, name + '.mjs');
  buildSync({ entryPoints: [fileURLToPath(new URL(relative, import.meta.url))], outfile,
    bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  return import(pathToFileURL(outfile).href);
}
const { sendOwnerTelegram } = await compile('./owner-telegram.ts', 'helper');
const { default: route } = await compile('../routes/admin-auto-heal.ts', 'route');
const secret = 'synthetic-organization-key';
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('uses authenticated organization bot door and requires delivery acknowledgment', async () => {
  let called = 0;
  const env = { DASORG_API_KEY: secret, ORGANIZATION: { fetch: async (url, init) => {
    called++;
    assert.equal(new URL(url).pathname, '/api/telegram-bot/send');
    assert.equal(init.headers.Authorization, 'Bearer ' + secret);
    assert.deepEqual(JSON.parse(init.body), { slug: 'mina-rutunya', text: 'ERP notice', report: true });
    return response({ ok: true, message_id: 123 });
  } }, TELEGRAMER: { fetch: () => { throw new Error('Saved Messages must not be used'); } } };
  assert.equal(await sendOwnerTelegram(env, 'ERP notice'), true);
  assert.equal(called, 1);
  for (const result of [{ ok: false }, { ok: true }]) {
    env.ORGANIZATION.fetch = async () => response(result);
    assert.equal(await sendOwnerTelegram(env, 'ERP notice'), false);
  }
  env.ORGANIZATION.fetch = async () => response({}, 502);
  assert.equal(await sendOwnerTelegram(env, 'ERP notice'), false);
  env.ORGANIZATION.fetch = async () => { throw new Error('network failure'); };
  assert.equal(await sendOwnerTelegram(env, 'ERP notice'), false);
  assert.equal(await sendOwnerTelegram({ TELEGRAMER_BRIDGE_SECRET: secret }, 'notice'), false);
});

test('notification check requires active admin and cannot customize recipient or text', async () => {
  let calls = 0;
  let role = 'viewer';
  const env = { DASORG_API_KEY: secret, DB: { prepare: () => ({ bind: () => ({ first: async () => ({
    id: 'admin-test', name: 'Test', role, active: 1, expires_at: Date.now() + 10000, permissions: '{}',
  }) }) }) }, ORGANIZATION: { fetch: async (_url, init) => {
    calls++;
    assert.equal(JSON.parse(init.body).slug, 'mina-rutunya');
    assert.notEqual(JSON.parse(init.body).text, 'untrusted text');
    return response({ ok: true, message_id: 124 });
  } } };
  const run = (auth) => route.request('/test-notification', { method: 'POST',
    headers: auth ? { Authorization: 'Bearer synthetic-session-token' } : {},
    body: JSON.stringify({ to: 'me', text: 'untrusted text' }) }, env);
  assert.equal((await run(false)).status, 401);
  assert.equal((await run(true)).status, 403);
  assert.equal(calls, 0);
  role = 'admin';
  assert.equal((await run(true)).status, 200);
  assert.equal(calls, 1);
  env.ORGANIZATION.fetch = async () => response({ ok: false });
  assert.equal((await run(true)).status, 502);
});
