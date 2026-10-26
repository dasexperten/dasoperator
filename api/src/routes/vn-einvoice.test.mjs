import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const dir = mkdtempSync(join(tmpdir(), 'vn-invoice-api-test-'));
require('esbuild').buildSync({
  entryPoints: [fileURLToPath(new URL('./vn-einvoice.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'route.mjs'),
});
const { default: route } = await import(pathToFileURL(join(dir, 'route.mjs')));
test.after(() => rmSync(dir, { recursive: true, force: true }));

const token = 'session-fixture-not-a-real-token';
function fixture(access = 'rw', overrides = {}, documents = []) {
  const reads = [], forwarded = [], archiveReads = [];
  const user = { id: 'operator-test', name: 'Test operator', role: 'manager', active: 1,
    expires_at: Date.now() + 60_000, permissions: JSON.stringify({ '/operations': access }), ...overrides };
  const env = {
    ERP_RUN_SECRET: 'service-fixture-not-a-real-secret',
    DB: { prepare(sql) { let values = []; return {
      bind(...args) { values = args; return this; },
      async first() {
        if (sql.includes('FROM sessions')) return values[0] === token ? user : null;
        reads.push(sql);
        if (sql.includes('provider_pdf_r2_key')) return { provider_pdf_r2_key: 'private/test.pdf', provider_xml_r2_key: null };
        return null;
      },
      async all() { reads.push(sql); return { results: /SELECT v\.\*/.test(sql) ? documents : [] }; },
      async run() { return { meta: { changes: 1 } }; },
    }; } },
    DOCS: { async get(key) { archiveReads.push(key); return { body: new Blob(['%PDF-fixture']).stream() }; } },
    VN_EINVOICE: { async fetch(req) {
      forwarded.push({ url: req.url, method: req.method, headers: Object.fromEntries(req.headers), body: await req.json() });
      return Response.json({ ok: true, document: { id: 'fixture-document', display_status: 'draft' } }, { status: 202 });
    } },
  };
  return { env, reads, forwarded, archiveReads };
}
function request(env, path = '/', method = 'GET', body, headers = {}) {
  return route.request(path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
}

test('missing, unknown, inactive and expired sessions cannot read invoice data or invoke the worker', async () => {
  for (const options of [{ token: '' }, { token: 'unknown-session-fixture' }, { active: 0 }, { expires_at: Date.now() - 1000 }]) {
    const f = fixture('rw', options);
    const headers = options.token !== undefined ? { Authorization: options.token ? `Bearer ${options.token}` : '' } : {};
    assert.equal((await request(f.env, '/', 'GET', undefined, headers)).status, 401);
    assert.equal((await request(f.env, '/', 'POST', {}, headers)).status, 401);
    assert.equal(f.reads.length, 0);
    assert.equal(f.forwarded.length, 0);
  }
});

test('users without operations permission cannot list, download or mutate invoices', async () => {
  const f = fixture('none');
  for (const [path, method] of [['/', 'GET'], ['/record/file/pdf', 'GET'], ['/', 'POST'], ['/record/transfer', 'POST'], ['/record/reconcile', 'POST']]) {
    assert.equal((await request(f.env, path, method, method === 'POST' ? {} : undefined)).status, 403);
  }
  assert.equal(f.reads.length, 0);
  assert.equal(f.archiveReads.length, 0);
  assert.equal(f.forwarded.length, 0);
});

test('read-only operators may list and download but cannot create, record transfer or reconcile', async () => {
  const f = fixture('read');
  assert.equal((await request(f.env)).status, 200);
  const file = await request(f.env, '/record/file/pdf');
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('cache-control'), 'private, no-store');
  assert.equal(await file.text(), '%PDF-fixture');
  for (const path of ['/', '/record/transfer', '/record/reconcile']) {
    assert.equal((await request(f.env, path, 'POST', {})).status, 403);
  }
  assert.equal(f.forwarded.length, 0);
});

test('authorized mutations use the authenticated actor and server credential, ignoring a spoofed actor header', async () => {
  for (const [access, role] of [['rw', 'manager'], ['full', 'manager'], ['none', 'admin']]) {
    const f = fixture(access, { role });
    for (const path of ['/', '/record/transfer', '/record/reconcile']) {
      const body = { source_order_id: 'fixture-order' };
      const res = await request(f.env, path, 'POST', body, { 'X-Actor-Id': 'spoofed-user' });
      assert.equal(res.status, 200);
      const sent = f.forwarded.at(-1);
      assert.equal(sent.headers.authorization, `Bearer ${f.env.ERP_RUN_SECRET}`);
      assert.equal(sent.headers['x-actor-id'], 'operator-test');
      assert.equal(sent.method, 'POST');
      assert.deepEqual(sent.body, body);
      const response = await res.text();
      assert.ok(!response.includes(f.env.ERP_RUN_SECRET));
      assert.ok(!response.includes(token));
    }
  }
});

test('missing service configuration and provider failures are returned without success', async () => {
  for (const key of ['VN_EINVOICE', 'ERP_RUN_SECRET']) {
    const f = fixture(); delete f.env[key];
    assert.equal((await request(f.env, '/', 'POST', {})).status, 503);
    assert.equal(f.forwarded.length, 0);
  }
  const f = fixture();
  f.env.VN_EINVOICE.fetch = async () => Response.json({ ok: false, error: 'existing_order_differs' }, { status: 409 });
  const res = await request(f.env, '/', 'POST', {});
  assert.equal(res.status, 409);
  assert.equal((await res.json()).success, false);
});

test('unarchived or unsupported file types do not reveal archive objects', async () => {
  const f = fixture('read');
  for (const kind of ['xml', 'secret']) assert.equal((await request(f.env, `/record/file/${kind}`)).status, 404);
  assert.equal(f.archiveReads.length, 0);
});

const savedOrder = {
  source_order_id:'530124445322445',currency:'VND',buyer:{kind:'business',name:'Buyer'},
  items:[{sku:'DE203',name:'GINGER',unit:'Tube',quantity:1,gross_amount:99000,vat_rate:8},{sku:'DE210',name:'INNOWEISS',unit:'Tube',quantity:1,gross_amount:199000,vat_rate:8}],
  shipping_gross:32800,shipping_discount:32800,total_gross:298000,
};
const savedRow = {id:'doc',state:'received',provider_invoice_status:0,transfer_at:null,normalized_order_json:JSON.stringify(savedOrder)};
test('saved order automatically returns source dates, items and tax totals without mutating transfer',async()=>{
  const source={order_created_at:'2026-10-25T22:37:00+07:00',provider_draft:{ArisingDate:'26/10/2026'},carrier:'J&T VN',tracking_number:'JNTMP0043304208VNA'};
  const f=fixture('read',{},[{...savedRow,source_snapshot_json:JSON.stringify(source)}]);
  const r=await request(f.env);assert.equal(r.status,200);const document=(await r.json()).result.documents[0];
  assert.deepEqual(document.source_facts,{order_created_at:source.order_created_at,draft_date:'26/10/2026',carrier:'J&T VN',tracking_number:source.tracking_number});
  assert.deepEqual(document.fiscal_totals,{net:275926,vat:22074,gross:298000});
  assert.deepEqual(document.fiscal_lines.map(x=>[x.sku,x.net_amount,x.vat_amount,x.gross_amount]),[['DE203',91667,7333,99000],['DE210',184259,14741,199000]]);
  assert.equal(document.transfer_at,null);assert.equal(document.display_status,'draft');assert.equal(document.source_snapshot_json,undefined);
  assert.equal(f.forwarded.length,0);assert.equal(f.archiveReads.length,0);
});
test('missing or malformed old source metadata keeps saved order usable and dates unset',async()=>{
  for(const source_snapshot_json of [null,'not-json','{}','null','[]','42']){
    const f=fixture('read',{},[{...savedRow,source_snapshot_json}]);const r=await request(f.env);assert.equal(r.status,200);
    const document=(await r.json()).result.documents[0];assert.deepEqual(document.source_facts,{order_created_at:null,draft_date:null,carrier:null,tracking_number:null});
    assert.equal(document.fiscal_totals.gross,298000);assert.equal(document.transfer_at,null);assert.equal(f.forwarded.length,0);
  }
});
