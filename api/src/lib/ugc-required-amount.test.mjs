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


test('unknown amount refuses execute and old-client paid-outside; no provider or new payout',async t=>{
 const f=fixture(t);assert.equal((await f.request('POST','/payouts/p/execute',{})).http,422);
 const outside=await f.request('POST','/payouts/paid-outside',{ids:['p']});assert.equal(outside.http,200);assert.deepEqual(outside.result.marked,[]);
 assert.equal((await f.store.getPayout('p')).amount_minor,1);assert.equal((await f.store.getPayout('p')).status,'awaiting_approval');
 assert.equal(f.calls.payments.length,0);assert.equal(f.sql.prepare('SELECT count(*) n FROM ugc_payouts').get().n,1);
});

test('complete existing Owner amount retains ordinary paid-outside marking without a transfer',async t=>{
 const f=fixture(t);f.sql.exec('UPDATE ugc_payouts SET amount_minor=45300');
 const outside=await f.request('POST','/payouts/paid-outside',{ids:['p']});assert.equal(outside.http,200);assert.deepEqual(outside.result.marked,['p']);
 assert.equal((await f.store.getPayout('p')).amount_minor,45300);assert.equal(f.calls.payments.length,0);
});

test('actual list readiness SQL requires name, canonical Russian phone and bank ID, exposes boolean only',async t=>{
 const source=readFileSync(new URL('../routes/ugc.ts',import.meta.url),'utf8');
 const expression=source.match(/\(CASE WHEN EXISTS \(SELECT 1 FROM ugc_payout_requisites r WHERE r.payout_id = p.id[\s\S]*?END\) has_requisites/)[0];
 const f=fixture(t),read=()=>f.sql.prepare(`SELECT ${expression} FROM ugc_payouts p WHERE p.id='p'`).get();
 assert.deepEqual({...read()},{has_requisites:1});
 for(const sql of ["UPDATE ugc_payout_requisites SET first_name=' '","UPDATE ugc_payout_requisites SET fps_mobile_phone='not phone'","UPDATE ugc_payouts SET fps_bank_member_id='123'","UPDATE ugc_payouts SET fps_bank_member_id='10000000000x'"]){
  f.sql.exec("UPDATE ugc_payout_requisites SET first_name='Имя',fps_mobile_phone='+79000000011';UPDATE ugc_payouts SET fps_bank_member_id='100000000004'");
  f.sql.exec(sql);assert.deepEqual({...read()},{has_requisites:0});
 }
});
