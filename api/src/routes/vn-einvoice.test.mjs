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
        if (/SELECT v\.\*/.test(sql)) return documents.find(d=>d.id===values[0])??null;
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
  for (const [path, method] of [['/', 'GET'], ['/record/file/pdf', 'GET'], ['/record','GET'], ['/record/operation','POST'], ['/', 'POST'], ['/record/transfer', 'POST'], ['/record/issue', 'POST'], ['/record/reconcile', 'POST']]) {
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
  for (const path of ['/', '/record/transfer', '/record/issue', '/record/reconcile', '/record/operation']) {
    assert.equal((await request(f.env, path, 'POST', {})).status, 403);
  }
  assert.equal(f.forwarded.length, 0);
});

test('authorized mutations use the authenticated actor and server credential, ignoring a spoofed actor header', async () => {
  for (const [access, role] of [['rw', 'manager'], ['full', 'manager'], ['none', 'admin']]) {
    const f = fixture(access, { role });
    for (const path of ['/', '/record/transfer', '/record/issue', '/record/reconcile']) {
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

function providerFixture(invoice, options={}) {
  const row={...savedRow,pattern:'1C26MAA',serial:'',ikey:'swh-530124445322445',response_r2_key:'private/provider-receipt.json',provider_checked_at:1793023866,
    source_document_json:JSON.stringify({id:'dex_lazada_530124445322445',status:'pending_review',reviewed_at:null,target_id:null}),...options.row};
  const f=fixture('read',{},[row]);
  f.env.DOCS.get=async key=>{f.archiveReads.push(key);return options.missing?null:{text:async()=>options.invalid?'not-json':JSON.stringify({httpStatus:200,body:{Status:2,ErrorCode:0,Data:{Invoices:[{Pattern:'1C26MAA',Serial:'',...invoice}]}}})};};
  return f;
}
test('successful read of an unsigned draft exposes unsent tax status and actual receipt time, not acceptance',async()=>{
  const f=providerFixture({Ikey:'swh-530124445322445',InvoiceStatus:0,No:'0',ArisingDate:'26/10/2026',TCTCheckStatus:'Chưa gửi thuế',TaxAuthorityCode:null});
  const doc=(await(await request(f.env)).json()).result.documents[0];
  assert.deepEqual(doc.provider_check,{available:true,invoice_status:0,invoice_no:'0',invoice_date:'26/10/2026',tax_status_raw:'Chưa gửi thuế',tax_error:null,tax_authority_code:null,checked_at:1793023866});
  assert.deepEqual(doc.accounting_document,{id:'dex_lazada_530124445322445',status:'pending_review',reviewed_at:null,target_id:null});
  assert.equal(f.forwarded.length,0);assert.equal(doc.transfer_at,null);
});
test('actual tax acceptance and issued number come from matching receipt, independently of saved draft metadata',async()=>{
  const f=providerFixture({Ikey:'swh-530124445322445',InvoiceStatus:1,No:'12',TCTCheckStatus:'Hợp lệ',TaxAuthorityCode:'CQT-test'});
  const doc=(await(await request(f.env)).json()).result.documents[0];
  assert.equal(doc.provider_check.invoice_status,1);assert.equal(doc.provider_check.invoice_no,'12');
  assert.equal(doc.provider_check.tax_status_raw,'Hợp lệ');assert.equal(doc.provider_check.tax_authority_code,'CQT-test');assert.equal(f.forwarded.length,0);
});
test('missing, malformed or mismatched receipts never inherit stored invoice or template claims',async()=>{
  for(const options of [{missing:true},{invalid:true},{mismatch:true},{seriesMismatch:true}]){
    const f=providerFixture({Ikey:options.mismatch?'other-invoice':'swh-530124445322445',Pattern:options.seriesMismatch?'other-series':'1C26MAA',InvoiceStatus:1,No:'12',TCTCheckStatus:1,TaxAuthorityCode:'CQT-test'},options);
    const doc=(await(await request(f.env)).json()).result.documents[0];
    assert.deepEqual(doc.provider_check,{available:false,invoice_status:null,invoice_no:null,invoice_date:null,tax_status_raw:null,tax_error:null,tax_authority_code:null,checked_at:null});
    assert.equal(f.forwarded.length,0);
  }
});

test('one-click release forwards the stored document id and authenticated actor without a transfer form', async () => {
  const f = fixture('rw');
  const res = await request(f.env, '/real-draft/issue', 'POST', {});
  assert.equal(res.status, 200);
  assert.equal(f.forwarded.length, 1);
  assert.equal(f.forwarded[0].url, 'https://vn-einvoice/manual/orders/real-draft/issue');
  assert.deepEqual(f.forwarded[0].body, {});
  assert.equal(f.forwarded[0].headers['x-actor-id'], 'operator-test');
});

test('missing linked invoice returns404 with no worker invocation for read or operation import',async()=>{
 const f=fixture();
 for(const [path,method] of [['/missing','GET'],['/missing/operation','POST']]) assert.equal((await request(f.env,path,method,method==='POST'?{}:undefined)).status,404);
 assert.equal(f.forwarded.length,0);
});

test('operation projection loads full canonical facts without issuing; import failure preserves successful fiscal response',async()=>{
 const f=fixture('rw',{},[{...savedRow,id:'fixture-document',ikey:'swh-530124445322445'}]);
 const read=await request(f.env,'/fixture-document');assert.equal(read.status,200);assert.equal((await read.json()).result.document.fiscal_totals.gross,298000);assert.equal(f.forwarded.length,0);
 f.env.VN_EINVOICE.fetch=async()=>Response.json({ok:true,document:{id:'fixture-document',display_status:'tax_accepted_archived',invoice_no:'1'}});
 const result=await request(f.env,'/fixture-document/issue','POST',{});assert.equal(result.status,200);const body=await result.json();assert.equal(body.result.document.invoice_no,'1');assert.equal(body.result.document.display_status,'tax_accepted_archived');assert.match(body.result.operation_sync_error,/vat_evidence_ref_required/);
});
