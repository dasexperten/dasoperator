// Real mounted routes + auth + payoutStore SQL on SQLite. Only the external
// provider is synthetic; no ERP, Konsol, Telegram or Instagram calls are made.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { saveAmountReview, readAmountReview } from './ugc-amount-review.mjs';


const temp = mkdtempSync(join(tmpdir(), 'ugc-payout-integration-'));
test.after(() => rmSync(temp, { recursive: true, force: true }));
await build({
  stdin: { contents: `export { default as route } from './routes/ugc.ts';
    export { payoutStore } from './lib/ugc-payout-store.ts';`, resolveDir: new URL('../', import.meta.url).pathname },
  bundle: true, platform: 'node', format: 'esm', outfile: join(temp, 'routes.mjs'), logLevel: 'silent',
  plugins: [{ name: 'synthetic-provider', setup(b) {
    b.onResolve({ filter: /\/konsol$/ }, a => ({ path: a.path, namespace: 'provider' }));
    b.onLoad({ filter: /.*/, namespace: 'provider' }, () => ({ contents: 'export const konsolClient = env => env.syntheticKonsol;' }));
    b.onResolve({ filter: /\/konsol-balance$/ }, a => ({ path: a.path, namespace: 'balance' }));
    b.onLoad({ filter: /.*/, namespace: 'balance' }, () => ({ contents: 'export const warnIfShort = async () => null; export const konsolOwnRub = async () => 0;' }));
  } }],
});
const { route, payoutStore } = await import(pathToFileURL(join(temp, 'routes.mjs')));
const PHONE = '+79000000011';
const NOW = Date.parse('2026-11-09T12:00:00Z');
const requisites = { phone: '+79000000022', first_name: 'Новое имя', fps_bank_member_id: '100000000005', bank_ref: 'Новый банк' };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function fixture(t) {
  t.mock.method(globalThis, 'fetch', async () => { throw Error('network forbidden'); });
  const sql = new DatabaseSync(':memory:');
  t.after(() => sql.close());
  sql.exec('PRAGMA foreign_keys=ON');
  for (const name of ['0098_ugc_creator_pipeline.sql', '0116_ugc_payouts.sql', '0119_ugc_payouts_konsol.sql',
    '0120_ugc_ig_messages.sql', '0127_ugc_source_records.sql', '0128_ugc_payout_product.sql',
    '0136_ugc_payout_notice_status.sql', '0151_ugc_handle_history.sql']) {
    sql.exec(readFileSync(new URL(`../../../db/migrations/${name}`, import.meta.url), 'utf8'));
  }
  sql.exec(`CREATE TABLE crm_sync_state(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,role TEXT,active INTEGER,permissions TEXT);
    CREATE TABLE sessions(token TEXT PRIMARY KEY,user_id TEXT,expires_at INTEGER);
    INSERT INTO users VALUES('owner','Test owner','admin',1,'{}'),
      ('writer','Test writer','manager',1,'{"/ugc":"rw"}'),
      ('reader','Test reader','manager',1,'{"/ugc":"read"}'),
      ('outsider','No access','manager',1,'{}');
    INSERT INTO ugc_creators(id,normalized_handle,created_at,updated_at) VALUES('c','synthetic',0,0);
    INSERT INTO ugc_payouts(id,creator_id,amount_minor,status,payout_date,created_at,updated_at,fps_bank_member_id,bank_ref)
      VALUES('p','c',1,'awaiting_approval','2026-11-09',0,0,'100000000004','Original bank');
    INSERT INTO ugc_payout_requisites(payout_id,fps_mobile_phone,first_name,created_at,updated_at)
      VALUES('p','${PHONE}','Имя',0,0);`);
  for (const user of ['owner', 'writer', 'reader', 'outsider']) sql.prepare('INSERT INTO sessions VALUES(?,?,?)').run(`${user}-test-session-token`, user, Date.now() + 3600000);
  const DB = {
    beforeBatch: null, corruptBatch: null, failBatchAt: null, afterCommit: null,
    prepare(query) {
      // D1 binds positional slots, including holes in ?1/?7. node:sqlite's
      // object binding needs explicit names only for the referenced slots.
      let index = 0;
      query = query.replace(/\?(?!\d)/g, () => `?${++index}`);
      const referenced = new Set([...query.matchAll(/\?(\d+)/g)].map(m => m[1]));
      let values = {};
      const stmt = {
        bind(...v) { values = Object.fromEntries(v.map((x, i) => [String(i + 1), x]).filter(([key]) => referenced.has(key))); return stmt; },
        async first() { return sql.prepare(query).get(values) ?? null; },
        async all() { return { success: true, results: sql.prepare(query).all(values) }; },
        async run() { return stmt.perform(); },
        perform() {
          if (/^\s*(SELECT|WITH)/i.test(query)) return { success: true, results: sql.prepare(query).all(values) };
          return { success: true, meta: { changes: Number(sql.prepare(query).run(values).changes) } };
        },
      };
      return stmt;
    },
    async batch(statements) {
      await DB.beforeBatch?.();
      sql.exec('BEGIN');
      let results;
      try {
        results = statements.map((s, i) => {
          if (i === DB.failBatchAt) throw Error('synthetic batch failure');
          return s.perform();
        });
        sql.exec('COMMIT');
      } catch (e) { sql.exec('ROLLBACK'); throw e; }
      DB.afterCommit?.();
      return DB.corruptBatch ? DB.corruptBatch(results) : results;
    },
  };
  const calls = { bank: [], accounts: 0, contractor: [], payments: [] };
  const hooks = { beforeClaim: null, afterClaim: null, payment: null };
  const konsol = {
    async bankMember(id) { calls.bank.push(id); await hooks.beforeClaim?.(); return { found: true, name: id }; },
    async companyAccounts() { calls.accounts++; return { ok: true, body: { collection: [{ balance: '1936615.38' }] } }; },
    async findContractorByPhone(phone) { calls.contractor.push(phone); await hooks.afterClaim?.(); return { id: 'synthetic-contractor' }; },
    async createPayment(body) { calls.payments.push(body); return hooks.payment ?? { ok: true, status: 201, body: { id: 'synthetic-payment', status: 'created' } }; },
  };
  const store = payoutStore({ DB });
  const deps = { store, konsol, claimToken: 'synthetic-claim', now: NOW, notifyOwner: async () => assert.fail('unexpected notification') };
  const request = async (method, path, body, user = 'owner') => {
    const response = await route.request(`https://erp.test${path}`, { method,
      headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${user}-test-session-token` } : {}) },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    }, { DB, syntheticKonsol: konsol });
    return { http: response.status, ...(await response.json()) };
  };
  const snapshot = () => JSON.stringify({ p: sql.prepare('SELECT * FROM ugc_payouts').all(), r: sql.prepare('SELECT * FROM ugc_payout_requisites').all() });
  const shown = async () => ({ ...(await store.getPayout('p')), has_requisites: 1 });
  return { sql, DB, calls, hooks, store, deps, request, snapshot, shown };
}

const rid='00000000-0000-4000-8000-000000000001';
async function payload(f,amount=45300){
 const r=await f.request('GET','/payouts/p/amount-review');assert.equal(r.http,200);
 return {creator_id:'c',expected_snapshot:r.result.review_snapshot,amount_minor:amount,request_id:rid};
}
const save=(f,body,user='owner')=>f.request('POST','/payouts/p/amount-review',body,user);
const holds=f=>f.sql.prepare("SELECT * FROM crm_sync_state WHERE key LIKE 'payout_hold:%'").all();

test('admin-only snapshot and save keep existing access checks; no private fields escape',async t=>{
 const f=fixture(t),body=await payload(f);
 for(const [user,status] of [[null,401],['outsider',403],['reader',403],['writer',403]]){
  assert.equal((await f.request('GET','/payouts/p/amount-review',undefined,user)).http,status);
  assert.equal((await save(f,body,user)).http,status);
 }
 const read=await f.request('GET','/payouts/p/amount-review');
 assert.deepEqual(Object.keys(read.result).sort(),['amount_minor','can_edit','creator_id','id','payout_hold','review_snapshot','saved_request','status','updated_at'].sort());
 assert.equal(read.result.can_edit,true);assert.equal(read.result.payout_hold,false);
 assert.doesNotMatch(JSON.stringify(read),new RegExp(PHONE.replace('+','\\+')));
});

test('one save updates only exact amount, creates persistent hold/receipt, no payment or new row',async t=>{
 const f=fixture(t),body=await payload(f),before=await f.store.getPayout('p'),req=await f.store.getRequisites('p');
 const out=await save(f,body);assert.equal(out.http,200);assert.equal(out.result.amount_minor,45300);
 assert.equal(out.result.payout_hold,true);assert.equal(out.result.can_edit,false);
 const after=await f.store.getPayout('p');for(const k of Object.keys(before))if(!['amount_minor','updated_at'].includes(k))assert.deepEqual(after[k],before[k],k);
 assert.deepEqual(await f.store.getRequisites('p'),req);assert.equal(holds(f).length,1);
 assert.equal(f.sql.prepare('SELECT count(*) n FROM ugc_payouts').get().n,1);assert.equal(f.calls.payments.length,0);
 const all=JSON.stringify(f.sql.prepare('SELECT * FROM crm_sync_state').all());assert.ok(!all.includes(PHONE));assert.ok(!all.includes('Имя'));
 const replay=await save(f,body);assert.equal(replay.http,200);assert.equal(replay.result.replay,true);
 const read=await f.request('GET',`/payouts/p/amount-review?request_id=${rid}`);assert.deepEqual(read.result.saved_request,{request_id:rid,expected_snapshot:body.expected_snapshot,amount_minor:45300});
});

test('394 RUB can be recorded without a banking name but remains held, never ready or executed',async t=>{
 const f=fixture(t);f.sql.exec("UPDATE ugc_payout_requisites SET first_name=NULL");
 const result=await save(f,await payload(f,39400));assert.equal(result.http,200);assert.equal(result.result.payout_hold,true);
 assert.equal((await f.store.getRequisites('p')).first_name,null);assert.equal(f.calls.payments.length,0);
});

test('even missing requisites can only become a held amount, not invented recipient data',async t=>{
 const f=fixture(t);f.sql.exec('DELETE FROM ugc_payout_requisites');
 assert.equal((await save(f,await payload(f,39400))).http,200);
 assert.equal(await f.store.getRequisites('p'),null);assert.equal(holds(f).length,1);
});

test('old-client execute, status and paid-outside cannot bypass the server hold; safe notes still work',async t=>{
 const f=fixture(t);assert.equal((await save(f,await payload(f))).http,200);
 assert.equal((await f.request('POST','/payouts/p/execute',{})).http,409);
 assert.equal(f.calls.payments.length,0);assert.equal(f.calls.contractor.length,0);
 assert.equal((await f.request('POST','/payouts/p/status',{status:'paid'})).http,409);
 assert.equal((await f.request('PATCH','/payouts/p',{amount_minor:55000})).http,409);
 const outside=await f.request('POST','/payouts/paid-outside',{ids:['p']});assert.equal(outside.http,200);assert.deepEqual(outside.result.marked,[]);
 assert.equal((await f.request('PATCH','/payouts/p',{note:'safe'})).http,200);
 assert.equal((await f.store.getPayout('p')).status,'awaiting_approval');assert.equal(holds(f).length,1);
});

for(const [label,sql] of Object.entries({
 amount:"UPDATE ugc_payouts SET amount_minor=52000",creator:"INSERT INTO ugc_creators(id,normalized_handle,created_at,updated_at) VALUES('other','other',0,0); UPDATE ugc_payouts SET creator_id='other'",
 status:"UPDATE ugc_payouts SET status='approved'",claim:"UPDATE ugc_payouts SET execute_claim='racing'",
 provider:"UPDATE ugc_payouts SET konsol_payment_id='provider'",sent:"UPDATE ugc_payouts SET status='sent'",paid:"UPDATE ugc_payouts SET status='paid'",outside:"UPDATE ugc_payouts SET konsol_status='paid_outside'",
 bank:"UPDATE ugc_payouts SET fps_bank_member_id='100000000005'",phone:"UPDATE ugc_payout_requisites SET fps_mobile_phone='+79000000012'",name:"UPDATE ugc_payout_requisites SET first_name='Changed'",
 requisitesDeleted:'DELETE FROM ugc_payout_requisites',hold:"INSERT INTO crm_sync_state VALUES('payout_hold:p','other review',0)"
}))test(`SQL CAS catches ${label} racing AFTER snapshot and before batch, even with same timestamps`,async t=>{
 const f=fixture(t),body=await payload(f);let afterMutation;
 f.DB.beforeBatch=()=>{f.DB.beforeBatch=null;f.sql.exec(sql);afterMutation=f.snapshot();};
 assert.equal((await save(f,body)).http,409);assert.equal(f.snapshot(),afterMutation);
 assert.equal(f.sql.prepare("SELECT count(*) n FROM crm_sync_state WHERE key LIKE 'ugc_amount_review:%'").get().n,0);
 assert.equal(f.calls.payments.length,0);
});

for(let index=0;index<6;index++)test(`statement ${index} exception rolls back amount/hold/receipt together`,async t=>{
 const f=fixture(t),body=await payload(f),before=f.snapshot();f.DB.failBatchAt=index;
 assert.equal((await save(f,body)).http,503);assert.equal(f.snapshot(),before);assert.equal(holds(f).length,0);
 assert.equal(f.sql.prepare('SELECT count(*) n FROM crm_sync_state').get().n,0);
});

test('existing hold is retained byte for byte, never replaced or released',async t=>{
 const f=fixture(t);f.sql.exec("INSERT INTO crm_sync_state VALUES('payout_hold:p','original hold',5)");
 assert.equal((await save(f,await payload(f))).http,200);assert.equal(holds(f)[0].value,'original hold');assert.equal(holds(f)[0].updated_at,5);
});

test('twenty concurrent repeats create one update and one receipt; conflicting intent rejected',async t=>{
 const f=fixture(t),body=await payload(f);const results=await Promise.all(Array.from({length:20},()=>save(f,body)));
 assert.ok(results.every(r=>r.http===200));assert.equal(results.filter(r=>!r.result.replay).length,1);
 assert.equal(f.sql.prepare("SELECT count(*) n FROM crm_sync_state WHERE key LIKE 'ugc_amount_review:%'").get().n,1);
 assert.equal((await save(f,{...body,amount_minor:39400})).http,409);
 assert.equal((await save(f,{...body,request_id:crypto.randomUUID()})).http,409);
});

test('lost commit reply returns uncertain; exact original request reconciles without another write',async t=>{
 const f=fixture(t),body=await payload(f);f.DB.afterCommit=()=>{throw Error('lost response');};
 assert.equal((await save(f,body)).http,503);assert.equal((await f.store.getPayout('p')).amount_minor,45300);
 f.DB.afterCommit=null;const replay=await save(f,body);assert.equal(replay.http,200);assert.equal(replay.result.replay,true);assert.equal(holds(f).length,1);
});

test('malformed batch acknowledgement is uncertain, never false success',async t=>{
 for(const mutate of [()=>[],r=>r.map(x=>({...x,success:undefined})),r=>{r[0].meta.changes=undefined;return r;},r=>{r[4].results[0].amount_minor=39400;return r;}]){
  const f=fixture(t),body=await payload(f);f.DB.corruptBatch=mutate;
  assert.equal((await save(f,body)).http,503);assert.equal(holds(f).length,1);
  f.DB.corruptBatch=null;assert.equal((await save(f,body)).http,200);
 }
});

test('after an independent financial edit the old receipt is not current proof',async t=>{
 const f=fixture(t),body=await payload(f);assert.equal((await save(f,body)).http,200);
 f.sql.exec("UPDATE ugc_payout_requisites SET first_name='new recipient'");
 assert.equal((await save(f,body)).http,409);
 assert.equal((await f.request('GET',`/payouts/p/amount-review?request_id=${rid}`)).result.saved_request,null);
});

test('invalid amount, extra financial/source fields, wrong actor/snapshot and malformed request make no writes',async t=>{
 const f=fixture(t),body=await payload(f),before=f.snapshot();
 for(const patch of [{amount_minor:1},{amount_minor:4999},{amount_minor:300000},{amount_minor:45300.1},{amount_minor:'45300'},{bank_ref:'wrong'},{status:'paid'},{verified:true},{actor_id:'fake'},{creator_id:'wrong'},{expected_snapshot:'0'.repeat(64)},{request_id:'wrong'}]){
  assert.ok([409,422].includes((await save(f,{...body,...patch})).http));assert.equal(f.snapshot(),before);assert.equal(holds(f).length,0);
 }
 for(const body of [null,[],{},'{'])assert.equal((await save(f,body)).http,422);
});

test('database-side invariant assertion rolls back hold loss or unintended financial trigger changes',async t=>{
 for(const trigger of ["DELETE FROM crm_sync_state WHERE key='payout_hold:p'", "UPDATE ugc_payouts SET bank_ref='unexpected' WHERE id='p'", "UPDATE ugc_payout_requisites SET first_name='unexpected' WHERE payout_id='p'"]){
  const f=fixture(t),body=await payload(f),before=f.snapshot();
  f.sql.exec(`CREATE TRIGGER mutate_after_amount AFTER UPDATE OF amount_minor ON ugc_payouts WHEN NEW.amount_minor=45300 BEGIN ${trigger}; END`);
  assert.equal((await save(f,body)).http,503);assert.equal(f.snapshot(),before);assert.equal(holds(f).length,0);
 }
});

test('old bulk paid-outside clients cannot turn an unconfirmed one-kopeck placeholder into paid',async t=>{
 const f=fixture(t);const result=await f.request('POST','/payouts/paid-outside',{ids:['p']});
 assert.equal(result.http,200);assert.deepEqual(result.result.marked,[]);assert.equal((await f.store.getPayout('p')).status,'awaiting_approval');
});

test('legacy generic PATCH prompt cannot bypass the mandatory held amount-review transaction',async t=>{
 const f=fixture(t),before=f.snapshot();
 const old=await f.request('PATCH','/payouts/p',{amount_rub:453});assert.equal(old.http,409);
 assert.equal(f.snapshot(),before);assert.equal(holds(f).length,0);
 assert.equal((await f.request('POST','/payouts/p/execute',{})).http,422);assert.equal(f.calls.payments.length,0);
 assert.equal((await save(f,await payload(f))).http,200);assert.equal(holds(f).length,1);
});


test('non-RUB rows cannot be reviewed even if a legacy schema allowed them',async t=>{
 const f=fixture(t);f.sql.exec("PRAGMA ignore_check_constraints=ON; UPDATE ugc_payouts SET currency='USD'");
 const before=f.snapshot(),read=await f.request('GET','/payouts/p/amount-review');assert.equal(read.result.can_edit,false);
 assert.equal((await save(f,{creator_id:'c',expected_snapshot:read.result.review_snapshot,amount_minor:45300,request_id:rid})).http,409);
 assert.equal(f.snapshot(),before);assert.equal(holds(f).length,0);
});

for(const set of ["konsol_contractor_id='existing'","konsol_status='created'"])test(`provider-linked placeholder is not editable: ${set}`,async t=>{
 const f=fixture(t);f.sql.exec(`UPDATE ugc_payouts SET ${set}`);const before=f.snapshot();
 const r=await f.request('GET','/payouts/p/amount-review');assert.equal(r.result.can_edit,false);
 assert.equal((await save(f,{creator_id:'c',expected_snapshot:r.result.review_snapshot,amount_minor:45300,request_id:rid})).http,409);
 assert.equal(f.snapshot(),before);assert.equal(holds(f).length,0);
});


test('list projects only contractor presence; amount review does not disclose provider identifier',async t=>{
 const f=fixture(t);f.sql.exec("UPDATE ugc_payouts SET konsol_contractor_id='synthetic-private-contractor'");
 const result=await f.request('GET','/payouts/p/amount-review');assert.equal(result.result.can_edit,false);
 assert.doesNotMatch(JSON.stringify(result),/synthetic-private-contractor|konsol_contractor_id/);
 const routeSource=readFileSync(new URL('../routes/ugc.ts',import.meta.url),'utf8');
 const projection=routeSource.slice(routeSource.indexOf('let payoutRows:'),routeSource.indexOf('const sourceIndex ='));
 assert.match(projection,/CASE WHEN COALESCE\(p\.konsol_contractor_id,''\)<>'' THEN 1 ELSE 0 END\) has_konsol_contractor/);
 assert.doesNotMatch(projection,/[, ]p\.konsol_contractor_id,/);
});
