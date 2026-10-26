import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const esbuildPath = createRequire(import.meta.url).resolve('esbuild', { paths: [root, join(root, 'workers')] });
const { build } = await import(pathToFileURL(esbuildPath).href);

// Exercise the real HTTP ingress and queue; replace only the unrelated run-log
// wrapper so these tests do not need the entire ERP journal schema.
const compiled = await build({
  entryPoints: [new URL('./index.ts', import.meta.url).pathname],
  bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'run-log', setup(b) {
    b.onResolve({ filter: /_shared\/run$/ }, () => ({ path: 'run-log', namespace: 'test' }));
    b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents:
      'export async function runLogged(env, name, cron, job) { return await job(env, false); }' }));
  } }],
});
const dir = mkdtempSync(join(tmpdir(), 'einvoice-ingress-'));
writeFileSync(join(dir, 'worker.mjs'), compiled.outputFiles[0].text);
const worker = (await import(join(dir, 'worker.mjs'))).default;
test.after(() => rmSync(dir, { recursive: true, force: true }));
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('unexpected_provider_call'); };
test.after(() => { globalThis.fetch = realFetch; });
const valid = { source_event_id: 'event-42', order_id: '42', action: 'issue',
  completed_at: '2026-09-22T11:20:00Z',
  xml_data: '<Invoices><Inv><Invoice><Ikey>swh-42</Ikey></Invoice></Inv></Invoices>' };
function fixture({ row = null, payload = valid, existing = null, enabled = false } = {}) {
  const writes = [], archived = [];
  let inserted;
  const env = {
    EASYINVOICE_ENABLED: enabled ? '1' : '0', EASYINVOICE_BASE_URL: 'https://api.easyinvoice.vn',
    EASYINVOICE_USERNAME: 'test', EASYINVOICE_PASSWORD: 'test', EASYINVOICE_TAX_CODE: 'test',
    EASYINVOICE_PATTERN: '1C26MAA', EASYINVOICE_SERIAL: '', SWIFTHUB_INGEST_SECRET: 'test-ingress', ERP_RUN_SECRET: 'test-run',
    DOCS: { put: async (...args) => archived.push(args), get: async () => ({ text: async () => JSON.stringify(payload) }) },
    DB: { prepare(sql) {
      let values = [];
      return { bind(...args) { values = args; return this; },
        async first() { if (/WHERE source_event_id/.test(sql)) return existing;
          if (/WHERE id/.test(sql)) return inserted; return null; },
        async all() { return { results: row ? [row] : [] }; },
        async run() { writes.push({ sql, values });
          if (/INSERT INTO vn_einvoice_documents/.test(sql)) inserted = { id: values[0], state: values[8] };
          return { success: true }; },
      };
    } },
  };
  return { env, writes, archived };
}
async function ingest(f, body) {
  const response = await worker.fetch(new Request('https://worker/webhooks/swifthub', {
    method: 'POST', headers: { authorization: 'Bearer test-ingress' }, body: JSON.stringify(body),
  }), f.env);
  return { status: response.status, body: await response.json() };
}
for (const [name, completed_at, error] of [
  ['missing', undefined, 'completed_at_required'], ['null', null, 'completed_at_required'],
  ['invalid', 'tomorrow', 'completed_at_invalid'], ['number', 100, 'completed_at_invalid'],
  ['timezone missing', '2026-09-22T11:20:00', 'completed_at_invalid'],
  ['impossible date', '2026-02-30T11:20:00Z', 'completed_at_invalid'],
  ['pending', '2099-09-22T11:20:00Z', 'completion_pending'],
]) test(`new issue rejects ${name} completion without writes or provider calls`, async () => {
  const f = fixture({ enabled: true });
  const result = await ingest(f, { ...valid, completed_at });
  assert.equal(result.status, 422); assert.equal(result.body.error, error);
  assert.equal(f.writes.length, 0); assert.equal(f.archived.length, 0);
});
for (const completed_at of ['2026-09-22T11:20:00Z', '2026-09-22T18:20:00+07:00', '2026-09-22T11:20:00.123456Z']) {
  test(`valid completion ${completed_at} retains disabled-provider receipt`, async () => {
    const f = fixture(); const result = await ingest(f, { ...valid, completed_at });
    assert.equal(result.status, 202); assert.equal(result.body.document.state, 'blocked_config');
    assert.equal(f.archived.length, 1); assert.equal(f.writes.length, 1);
  });
}
test('existing fiscal event replays without changing its outcome', async () => {
  const f = fixture({ existing: { id: 'existing', state: 'issued' }, enabled: true });
  const result = await ingest(f, { ...valid, completed_at: undefined });
  assert.equal(result.status, 200); assert.equal(result.body.idempotent, true);
  assert.equal(f.writes.length, 0); assert.equal(f.archived.length, 0);
});
for (const action of ['adjust', 'replace', 'cancel']) test(`${action} retains its separate contract`, async () => {
  const f = fixture(); const result = await ingest(f, { ...valid, action,
    ikey: 'swh-42', original_ikey: 'original', completed_at: undefined });
  assert.equal(result.status, 202); assert.equal(f.writes.length, 1);
});
for (const state of ['received', 'blocked_config']) test(`legacy ${state} issue is held before any provider preflight`, async () => {
  const f = fixture({ enabled: true, payload: { ...valid, completed_at: undefined },
    row: { id: 'legacy', action: 'issue', state, request_r2_key: 'legacy.json' } });
  const response = await worker.fetch(new Request('https://worker/run', {
    method: 'POST', headers: { authorization: 'Bearer test-run' },
  }), f.env);
  assert.equal(response.status, 200); assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].values[0], 'manual_review');
  assert.equal(f.writes[0].values[1], 'completed_at_required');
  assert.equal(f.archived.length, 0);
});
const queuedIssue = { id: 'queued', source_order_id: '42', ikey: 'swh-42', action: 'issue',
  state: 'received', request_r2_key: 'queued.json', retry_count: 0, verify_count: 0 };
async function runQueue(f) {
  return worker.fetch(new Request('https://worker/run', { method: 'POST',
    headers: { authorization: 'Bearer test-run' } }), f.env);
}
test('valid queued issue reaches provider status then submission', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url));
    return Response.json(calls.length === 1
      ? { Status: 2, Data: { KeyInvoiceMsg: { 'swh-42': '-1' } } }
      : { Status: 5, ErrorCode: 176 });
  });
  const f = fixture({ enabled: true, row: queuedIssue });
  await runQueue(f);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /checkInvoiceState$/);
  assert.match(calls[1], /importAndIssueInvoice$/);
});
test('stored completion is checked again immediately before submission', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url));
    return Response.json({ Status: 2, Data: { KeyInvoiceMsg: { 'swh-42': '-1' } } });
  });
  const f = fixture({ enabled: true, row: queuedIssue });
  let reads = 0;
  f.env.DOCS.get = async () => ({ text: async () => JSON.stringify(++reads === 1
    ? valid : { ...valid, completed_at: undefined }) });
  await runQueue(f);
  assert.equal(calls.length, 1);
  assert.equal(f.writes.at(-1).values[0], 'manual_review');
});
test('uncertain prior submission keeps verification even without completed_at', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url));
    return Response.json({ Status: 2, Data: { KeyInvoiceMsg: { 'swh-42': '-1' } } });
  });
  const f = fixture({ enabled: true, row: { ...queuedIssue, state: 'verify_pending' },
    payload: { ...valid, completed_at: undefined } });
  f.env.DOCS.get = async () => { throw new Error('verification_does_not_need_source_payload'); };
  await runQueue(f);
  assert.equal(calls.length, 1); assert.match(calls[0], /checkInvoiceState$/);
  assert.equal(f.writes.some(w => w.values[0] === 'manual_review'), false);
});
