import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
let build;
try { ({ build } = require('esbuild')); } catch { ({ build } = createRequire(new URL('../../../workers/package.json', import.meta.url))('esbuild')); }
const dir = mkdtempSync(join(tmpdir(), 'ugc-sweep-'));
const outfile = join(dir, 'sweep.mjs');
await build({ entryPoints: [fileURLToPath(new URL('./ugc-payout-store.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', outfile,
  plugins: [{ name: 'no-external-effects', setup(b) {
    b.onResolve({ filter: /^\.\/(konsol|owner-telegram|ugc-payout-execute\.mjs|ig-dm-watch|diana-compose|mina-alert|ig-dm-reply)$/ }, a => ({ path: a.path, namespace: 'mock' }));
    b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: `
      export const konsolClient=()=>globalThis.__sweep.client;
      export const sendOwnerTelegram=async()=>{throw Error('unexpected message')};
      export const applyKonsolPayment=async(row)=>{globalThis.__sweep.applied.push(row.id);return {changed:false,status:'sent'}};
      export const bloggerFailedText=()=> 'failed notice', bloggerPaidText=()=> 'paid notice';
      export const executePayout=async()=>{throw Error('unexpected payment')};
      export const matchRegistryPayment=()=>({reason:'no match'}), REGISTRY_LINK_IDS=['legacy'];
      export const sendIgDirect=(_e,handle)=>globalThis.__sweep.send(handle);
      export const dianaCompose=async(_e,handle)=>['notice '+handle];
      export const alertMina=async()=>true;
      export const queueForBrowser=async(_e,handle)=>{globalThis.__sweep.queued.push(handle)};
    ` }));
  } }] });
const { ugcPayoutSweep } = await import(pathToFileURL(outfile)); rmSync(dir, { recursive: true });

const row = id => ({ id, handle: id, creator_id: 'c-' + id, konsol_payment_id: 'k-' + id, amount_minor: 40000 });
function fixture(t, options = {}) {
  t.mock.method(globalThis, 'fetch', async () => { throw Error('network forbidden in payout test'); });
  const f = { pending: [], paid: [], failed: [], registry: [], paymentResults: {}, noticeResults: {}, claims: new Set(), released: [], applied: [], sent: [], queued: [], ...options };
  f.client = {
    async getPayment(id) { const result = f.paymentResults[id]; if (result instanceof Error) throw result; return result ?? { ok: true, body: { id } }; },
    async listPayments() { if (f.registryResult instanceof Error) throw f.registryResult; return f.registryResult ?? { ok: true, body: { collection: [] } }; }
  };
  f.send = async handle => { f.sent.push(handle); const result = f.noticeResults[handle]; if (result instanceof Error) throw result; return result ?? { ok: true, messageId: 'message-' + handle }; };
  f.env = { DB: { prepare(sql) { let p; const q = {
    bind(...values) { p = values; return q; },
    async all() {
      if (sql.includes('WHERE id IN')) return { results: f.registry };
      if (sql.includes('SELECT konsol_payment_id')) return { results: [] };
      if (sql.includes("SELECT id FROM ugc_payouts WHERE status='sent'")) return { results: f.pending.map(id => ({ id })) };
      if (sql.includes("SELECT * FROM ugc_payouts WHERE status='paid'")) return { results: f.paid.map(row) };
      if (sql.includes("SELECT * FROM ugc_payouts WHERE status='failed'")) return { results: f.failed.map(row) };
      if (sql.includes('SELECT p.id, p.handle')) { if (f.reminderError) throw f.reminderError; return { results: [] }; }
      throw Error('unexpected all ' + sql);
    },
    async first() {
      if (sql.includes('SELECT p.*')) return row(p[0]);
      if (sql.includes('MAX(created_at)')) return { t: new Date().toISOString() };
      throw Error('unexpected first ' + sql);
    },
    async run() {
      if (sql.includes('SET paid_notice_at=?2')) { if (f.claims.has(p[0])) return { meta: { changes: 0 } }; f.claims.add(p[0]); }
      else if (sql.includes('SET paid_notice_at=NULL')) { f.claims.delete(p[0]); f.released.push(p[0]); }
      else if (!sql.includes('notice_status') && !sql.includes('INSERT INTO crm_sync_state')) throw Error('unexpected run ' + sql);
      return { meta: { changes: 1 } };
    }
  }; return q; } } };
  globalThis.__sweep = f; return f;
}

test('partial refresh failures are reported after successful rows, without releasing existing claims', async t => {
  const f = fixture(t, { pending: ['bad', 'good', 'throws'], paymentResults: { 'k-bad': { ok: false, error: 'unavailable' }, 'k-throws': new Error('connection lost') }, claims: new Set(['protected']) });
  await assert.rejects(ugcPayoutSweep(f.env), /refresh=2/);
  assert.deepEqual(f.applied, ['good']); assert.deepEqual([...f.claims], ['protected']); assert.equal(f.released.length, 0);
});

test('failed paid and failed notices fail the sweep; successful, queued and preclaimed notices keep their claims', async t => {
  const f = fixture(t, { paid: ['paid-good', 'paid-bad', 'queued', 'claimed'], failed: ['failed-good', 'failed-bad'], claims: new Set(['claimed']), noticeResults: {
    'paid-bad': { ok: false, error: 'temporary failure' }, 'failed-bad': new Error('send failed'), queued: { ok: false, error: 'outside allowed window' }
  } });
  await assert.rejects(ugcPayoutSweep(f.env), error => /paid_notice=1/.test(error.message) && /failed_notice=1/.test(error.message));
  assert.deepEqual([...f.claims].sort(), ['claimed', 'failed-good', 'paid-good', 'queued']);
  assert.deepEqual(f.released.sort(), ['failed-bad', 'paid-bad']); assert.deepEqual(f.queued, ['queued']);
  assert.equal(f.sent.filter(h => h === 'paid-bad').length, 2); // Existing immediate send repeat only.
  assert.ok(!f.sent.includes('claimed'));
});

test('successful progress retains the numeric interface; no registry match is not a failure', async t => {
  const f = fixture(t, { registry: [{ id: 'legacy' }], pending: ['good'], paid: ['paid', 'queued'], noticeResults: { queued: { ok: false, error: 'outside allowed window' } } });
  assert.equal(await ugcPayoutSweep(f.env), 3); assert.deepEqual(f.applied, ['good']); assert.deepEqual([...f.claims].sort(), ['paid', 'queued']);
});

test('explicit registry failure or throw and thrown reminders are aggregated after other progress', async t => {
  for (const registryResult of [{ ok: false, error: 'list unavailable' }, new Error('list unavailable')]) {
    const f = fixture(t, { registry: [{ id: 'legacy' }], registryResult, pending: ['good'], reminderError: new Error('D1 reminders unavailable') });
    await assert.rejects(ugcPayoutSweep(f.env), error => /registry=1/.test(error.message) && /reminders=1/.test(error.message));
    assert.deepEqual(f.applied, ['good']);
  }
});
