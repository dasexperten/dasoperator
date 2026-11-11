import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
const bundle=await build({entryPoints:[fileURLToPath(new URL('./diana-cloud-round-schedule.ts',import.meta.url))],bundle:true,format:'esm',platform:'node',write:false});
const {dianaRoundSlot,scheduleDianaRound}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
function fixture(t,mode='enabled'){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE crm_sync_state(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER)');
 db.prepare('INSERT INTO crm_sync_state VALUES(?,?,?)').run('diana_direct_mode',mode,0);
 const DB={prepare(sql){let args=[];return{bind(...v){args=v;return this},async first(){return db.prepare(sql).get(...args)??null},async run(){return{meta:{changes:Number(db.prepare(sql).run(...args).changes)}}}}}};
 const created=[];const env={DB,DIANA_ROUND:{async create(p){created.push(p)},async get(){throw Error('not found')}}};return{db,env,created};
}
test('Owner 2026-11-11: round slots are exactly 06:00-06:29 and 18:00-18:29 Yerevan',()=>{
 const midnight=Date.parse('2026-11-10T00:00:00+04:00');
 for(let m=0;m<1440;m++){
  const slot=dianaRoundSlot(midnight+m*60_000);
  assert.equal(slot?.period??null,m>=360&&m<390?'morning':m>=1080&&m<1110?'evening':null);
 }
});
test('round starts once per slot, independently of Diana Direct, and only while Direct is enabled',async t=>{
 const f=fixture(t),at=Date.parse('2026-11-10T06:00:00+04:00');
 f.db.prepare('INSERT INTO crm_sync_state VALUES(?,?,?)').run('diana_direct_active','direct-x',1); // Direct busy: round still starts
 assert.equal((await scheduleDianaRound(f.env,at)).scheduled,true);assert.equal(f.created.length,1);
 assert.equal(f.created[0].id,'diana-round-2026-11-10-morning');
 assert.equal((await scheduleDianaRound(f.env,at+60_000)).reason,'already_started');assert.equal(f.created.length,1);
 assert.equal((await scheduleDianaRound(f.env,Date.parse('2026-11-10T18:05:00+04:00'))).scheduled,true);assert.equal(f.created[1].id,'diana-round-2026-11-10-evening');
 const off=fixture(t,'disabled');assert.equal((await scheduleDianaRound(off.env,at)).reason,'direct_disabled');assert.equal(off.created.length,0);
});
test('a lost create is inspected, never started twice',async t=>{
 const f=fixture(t),at=Date.parse('2026-11-10T18:00:00+04:00');let gets=0;
 f.env.DIANA_ROUND={async create(){throw Error('network')},async get(){gets++;return{async status(){return{status:'running'}}}}};
 assert.equal((await scheduleDianaRound(f.env,at)).scheduled,true);assert.equal(gets,1);
});
