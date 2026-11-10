import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const bundle=await build({entryPoints:[fileURLToPath(new URL('./ugc-payout-store.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',write:false});
const {payoutStore}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
test('claim compares amount, bank, version and recipient in one atomic update',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec(`CREATE TABLE ugc_payouts(id TEXT PRIMARY KEY,execute_claim TEXT,execute_claimed_at TEXT,konsol_error TEXT,updated_at INTEGER,konsol_payment_id TEXT,status TEXT,amount_minor INTEGER,fps_bank_member_id TEXT);
 CREATE TABLE ugc_payout_requisites(payout_id TEXT,fps_mobile_phone TEXT,first_name TEXT,last_name TEXT,patronymic TEXT);
 CREATE TABLE crm_sync_state(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER);
 INSERT INTO ugc_payouts VALUES('p1',NULL,NULL,NULL,1,NULL,'awaiting_approval',45300,'100000000004');
 INSERT INTO ugc_payout_requisites VALUES('p1','+79000000011','Елена',NULL,NULL);`);
 const DB={prepare(sql){let args=[];const q={bind(...v){args=v;return q},async run(){return {meta:{changes:db.prepare(sql).run(...args).changes}}}};return q}};
 const store=payoutStore({DB});
 const snapshot={row:{amount_minor:45300,fps_bank_member_id:'100000000004',updated_at:1},requisites:{fps_mobile_phone:'+79000000011',first_name:'Елена',last_name:null,patronymic:null}};
 db.exec("UPDATE ugc_payout_requisites SET first_name='Анна' WHERE payout_id='p1'");
 assert.equal(await store.claim('p1','claim','2026-11-10T00:00:00Z',snapshot),false);
 db.exec("UPDATE ugc_payout_requisites SET first_name='Елена' WHERE payout_id='p1'; UPDATE ugc_payouts SET amount_minor=45400 WHERE id='p1'");
 assert.equal(await store.claim('p1','claim','2026-11-10T00:00:00Z',snapshot),false);
 db.exec("UPDATE ugc_payouts SET amount_minor=45300 WHERE id='p1'");
 assert.equal(await store.claim('p1','claim','2026-11-10T00:00:00Z',snapshot),true);
 assert.equal(await store.claim('p1','other','2026-11-10T00:00:00Z',snapshot),false);
});
