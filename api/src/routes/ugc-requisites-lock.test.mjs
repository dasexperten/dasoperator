import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';

const b=await build({entryPoints:[fileURLToPath(new URL('./ugc.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',write:false,
 plugins:[{name:'auth',setup(build){build.onResolve({filter:/^\.\.\/lib\/auth$/},()=>({path:'auth',namespace:'fixture'}));
 build.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const validateSession=async()=>({role:"admin"});export const hasModuleAccess=()=>true;'}));}}]});
const {default:ugc}=await import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].text).toString('base64'));
test('a claim acquired while requisites are being saved prevents both writes',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec(`CREATE TABLE ugc_payouts(id TEXT PRIMARY KEY,konsol_payment_id TEXT,execute_claim TEXT,phone_masked TEXT,fps_bank_member_id TEXT,bank_ref TEXT,updated_at INTEGER);
 CREATE TABLE ugc_payout_requisites(payout_id TEXT PRIMARY KEY,fps_mobile_phone TEXT,first_name TEXT,last_name TEXT,patronymic TEXT,created_at INTEGER,updated_at INTEGER);
 INSERT INTO ugc_payouts VALUES('p1',NULL,NULL,'old','100000000004','old',1);
 INSERT INTO ugc_payout_requisites VALUES('p1','+79000000011','Old',NULL,NULL,1,1);`);
 let race=true;
 const DB={prepare(sql){let p=[];const q={bind(...v){p=v;return q},async first(){return db.prepare(sql).get(...p)??null},async run(){return /^\s*SELECT/i.test(sql)?{results:db.prepare(sql).all(...p)}:{meta:{changes:db.prepare(sql).run(...p).changes}}}};return q},
 async batch(qs){if(race)db.exec("UPDATE ugc_payouts SET execute_claim='in-flight' WHERE id='p1'");db.exec('BEGIN');try{const out=[];for(const q of qs)out.push(await q.run());db.exec('COMMIT');return out}catch(e){db.exec('ROLLBACK');throw e}}};
 const request=()=>new Request('https://example.test/payouts/p1/requisites',{method:'PUT',headers:{Authorization:'Bearer test','Content-Type':'application/json'},body:JSON.stringify({phone:'+79000000022',fps_bank_member_id:'100000000111',first_name:'New'})});
 const res=await ugc.fetch(request(),{DB});
 assert.equal(res.status,409);assert.equal(db.prepare("SELECT first_name FROM ugc_payout_requisites WHERE payout_id='p1'").get().first_name,'Old');
 assert.equal(db.prepare("SELECT fps_bank_member_id FROM ugc_payouts WHERE id='p1'").get().fps_bank_member_id,'100000000004');
 race=false;db.exec("UPDATE ugc_payouts SET execute_claim=NULL WHERE id='p1'");
 assert.equal((await ugc.fetch(request(),{DB})).status,200);
 assert.equal(db.prepare("SELECT first_name FROM ugc_payout_requisites WHERE payout_id='p1'").get().first_name,'New');
});
