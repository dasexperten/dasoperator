import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
const bundle=await build({entryPoints:[fileURLToPath(new URL('./diana-cloud-round-schedule.ts',import.meta.url))],bundle:true,format:'esm',platform:'node',write:false});
const {dianaRoundSlot,scheduleDianaRound}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec("CREATE TABLE crm_sync_state(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER);INSERT INTO crm_sync_state VALUES('diana_cloud_mode','enabled',0)");
 const DB={prepare(sql){let args=[];return{bind(...v){args=v;return this},async first(){return db.prepare(sql).get(...args)??null},async run(){return{meta:{changes:Number(db.prepare(sql).run(...args).changes)}}}}}};
 const created=[];const env={DB,DIANA_ROUND:{async create(p){created.push(p)},async get(){throw Error('not found')}}};return{db,env,created};
}
test('round slots are exactly 00:00-00:29 and 06:00-06:29 Moscow',()=>{
 const midnight=Date.parse('2026-11-10T00:00:00+03:00');
 for(let m=0;m<1440;m++){
  const slot=dianaRoundSlot(midnight+m*60_000);
  assert.equal(slot?.period??null,m<30?'night':m>=360&&m<390?'morning':null);
 }
});
test('round starts once for a slot and does not start while Direct owns the shared lock',async t=>{
 const f=fixture(t),at=Date.parse('2026-11-10T06:00:00+03:00');
 f.db.prepare('INSERT INTO crm_sync_state VALUES(?,?,?)').run('diana_cloud_execution_lock',JSON.stringify({kind:'direct',id:'one'}),1);
 assert.equal((await scheduleDianaRound(f.env,at)).reason,'diana_busy');assert.equal(f.created.length,0);
 f.db.prepare('DELETE FROM crm_sync_state WHERE key=?').run('diana_cloud_execution_lock');
 assert.equal((await scheduleDianaRound(f.env,at+60_000)).scheduled,true);assert.equal(f.created.length,1);
 assert.equal((await scheduleDianaRound(f.env,at+120_000)).reason,'already_started');assert.equal(f.created.length,1);
});
test('a round still blocked at the end of its window remains queued and starts afterwards',async t=>{
 const f=fixture(t),at=Date.parse('2026-11-10T06:29:00+03:00');
 f.db.prepare('INSERT INTO crm_sync_state VALUES(?,?,?)').run('diana_cloud_execution_lock',JSON.stringify({kind:'direct',id:'one'}),1);
 const result=await scheduleDianaRound(f.env,at);assert.equal(result.queued,true);
 const row=f.db.prepare('SELECT value FROM crm_sync_state WHERE key=?').get('diana_round_run:'+result.id);
 assert.equal(JSON.parse(row.value).status,'waiting');assert.equal(f.created.length,0);
 f.db.prepare('DELETE FROM crm_sync_state WHERE key=?').run('diana_cloud_execution_lock');
 assert.equal((await scheduleDianaRound(f.env,at+120_000)).scheduled,true);assert.equal(f.created.length,1);
});
