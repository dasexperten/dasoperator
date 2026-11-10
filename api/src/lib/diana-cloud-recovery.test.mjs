import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {build} from 'esbuild';import {fileURLToPath} from 'node:url';
const b=await build({entryPoints:[fileURLToPath(new URL('./diana-cloud-lock.ts',import.meta.url))],bundle:true,format:'esm',platform:'node',write:false});const {recoverDianaCloudLock}=await import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].text).toString('base64'));
function fixture(t){const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE crm_sync_state(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER)');const owner={kind:'round',id:'round-one'};db.prepare('INSERT INTO crm_sync_state VALUES(?,?,?)').run('diana_cloud_execution_lock',JSON.stringify(owner),1);const DB={prepare(sql){let a=[];return{bind(...v){a=v;return this},async first(){return db.prepare(sql).get(...a)??null},async run(){return{meta:{changes:Number(db.prepare(sql).run(...a).changes)}}}}}};return{db,env:{DB},owner};}
test('unavailable instance is never assumed absent; exactly three observations, then stop',async t=>{
 const f=fixture(t);let calls=0;f.env.DIANA_ROUND={async get(){calls++;throw Error('not found')}};
 for(let i=0;i<3;i++)assert.equal((await recoverDianaCloudLock(f.env,200_000)).reason,'workflow_status_unavailable');
 assert.equal((await recoverDianaCloudLock(f.env,200_000)).reason,'recovery_attempts_exhausted');assert.equal(calls,3);
 assert.ok(f.db.prepare('SELECT value FROM crm_sync_state WHERE key=?').get('diana_cloud_execution_lock'));
 const receipt=JSON.parse(f.db.prepare('SELECT value FROM crm_sync_state WHERE key=?').get('diana_cloud_recovery:round:round-one').value);assert.equal(receipt.reason,'workflow_status_unavailable');
});
test('only a positively terminal exact workflow releases its lock',async t=>{
 const f=fixture(t);let state='running';f.env.DIANA_ROUND={async get(id){assert.equal(id,'round-one');return{async status(){return{status:state}}}}};
 assert.equal((await recoverDianaCloudLock(f.env,200_000)).reason,'workflow_active');assert.ok(f.db.prepare('SELECT 1 FROM crm_sync_state WHERE key=?').get('diana_cloud_execution_lock'));
 state='complete';assert.equal((await recoverDianaCloudLock(f.env,200_000)).released,true);assert.equal(f.db.prepare('SELECT 1 FROM crm_sync_state WHERE key=?').get('diana_cloud_execution_lock'),undefined);
});
test('a newer owner is never released after an older status response',async t=>{
 const f=fixture(t);f.env.DIANA_ROUND={async get(){return{async status(){f.db.prepare('UPDATE crm_sync_state SET value=? WHERE key=?').run(JSON.stringify({kind:'direct',id:'new'}),'diana_cloud_execution_lock');return{status:'complete'}}}}};
 assert.equal((await recoverDianaCloudLock(f.env,200_000)).reason,'lock_owner_changed');assert.equal(JSON.parse(f.db.prepare('SELECT value FROM crm_sync_state WHERE key=?').get('diana_cloud_execution_lock').value).id,'new');
});
