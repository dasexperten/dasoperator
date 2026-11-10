import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {canRecoverInitialTechnicalFailure as guard} from './diana-direct-technical-recovery.mjs';
const now=Date.parse('2026-11-10T18:00:00Z');
async function fixture(t) {
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec('CREATE TABLE crm_sync_state(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER)');
 const event={cid:'chat',message_id:'incoming',event_id:'message:incoming',at:'2026-11-10T16:00:00Z',queue_key:'diana_round_alarm:chat',handle:'creator'};
 const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(event.event_id)))].map(x=>x.toString(16).padStart(2,'0')).join('');
 const prior={status:'failed',reason:'recovery_technical_retryable',event_id:event.event_id,workflow_id:'direct-v1-'+hash,at:now-240000};
 const f={db,event,prior,created:[],status:'errored',files:new Set()};
 f.put=(k,v)=>db.prepare('INSERT OR REPLACE INTO crm_sync_state VALUES(?,?,?)').run(k,JSON.stringify(v),now);
 f.env={DB:{prepare(sql){let a=[];return {bind(...v){a=v;return this;},async first(){return db.prepare(sql).get(...a)??null;},async all(){return{results:db.prepare(sql).all(...a)};},async run(){return {meta:{changes:Number(db.prepare(sql).run(...a).changes)}};}};}},DOCS:{async head(k){if(f.failR2)throw Error('offline');return f.files.has(k)?{}:null;}},DIANA_CLOUD:{async get(id){if(f.failStatus)throw Error('offline');assert.equal(id,prior.workflow_id);return{async status(){return{status:f.status}}};},async create(p){f.created.push(p);}}};
 f.put('diana_cloud_event:'+event.event_id,prior);return f;
}
test('terminal original before decision is eligible without writes or sends',async t=>{const f=await fixture(t);assert.equal(await guard(f.env,f.event,f.prior,now),true);assert.equal(f.created.length,0);});
for(const status of ['running','queued','waiting','paused'])test('blocks '+status+' workflow',async t=>{const f=await fixture(t);f.status=status;assert.equal(await guard(f.env,f.event,f.prior,now),false);});
for(const flag of ['failStatus','failR2'])test('fails closed on '+flag,async t=>{const f=await fixture(t);f[flag]=true;assert.equal(await guard(f.env,f.event,f.prior,now),false);});
for(const prefix of ['diana_event_done:','diana_payout_signal:','diana_payout_reconciliation:'])test('blocks durable '+prefix,async t=>{const f=await fixture(t);f.put(prefix+f.event.event_id,{});assert.equal(await guard(f.env,f.event,f.prior,now),false);});
test('blocks any decision artifact before payout intake could have happened',async t=>{const f=await fixture(t);f.files.add('diana/cloud-direct/v1/'+f.prior.workflow_id.slice(10)+'/decision.json');assert.equal(await guard(f.env,f.event,f.prior,now),false);});
for(const suffix of ['',':action:paid'])test('blocks even malformed or pending outbox '+suffix,async t=>{const f=await fixture(t);f.db.prepare('INSERT INTO crm_sync_state VALUES(?,?,?)').run('ig_reply_delivery:chat:'+new Date(f.event.at).toISOString()+suffix,'not-json',now);assert.equal(await guard(f.env,f.event,f.prior,now),false);});
test('older original outbox does not block current untouched original',async t=>{const f=await fixture(t);f.put('ig_reply_delivery:chat:2026-11-09T16:00:00.000Z',{status:'complete'});assert.equal(await guard(f.env,f.event,f.prior,now),true);});
test('rejects young, unknown, financial, and mismatched identities',async t=>{const f=await fixture(t);for(const [event,prior] of [[f.event,{...f.prior,at:now}],[{...f.event,task:'payout_paid_notice'},f.prior],[f.event,{...f.prior,workflow_id:'direct-v1-'+'a'.repeat(64)}],[f.event,{...f.prior,reason:'unknown'}]])assert.equal(await guard(f.env,event,prior,now),false);});
const raw=await readFile(new URL('./diana-cloud-dispatch.ts',import.meta.url),'utf8');
const stripped=stripTypeScriptTypes(raw.replace(/^import .*;\n/gm,''));
const prelude=`
const canRecoverInitialTechnicalFailure=(...a)=>globalThis.__recoveryGuard(...a);
const pendingDianaMessages=async()=>globalThis.__waiting;
const dianaWorkWindow=()=>({direct:true,date:'2026-11-10'});
const igDeliveryKey=(cid,at)=>'ig_reply_delivery:'+cid+':'+at;
const reserveDianaCloud=async()=>true,releaseDianaCloud=async()=>{},recoverDianaCloudLock=async()=>({released:false}),readDianaCloudLock=async()=>null;
`;
const {dispatchDianaCloud}=await import('data:text/javascript;base64,'+Buffer.from(prelude+stripped).toString('base64'));
test('dispatcher creates bounded recovery with original identity and payments disabled',async t=>{
 const f=await fixture(t);globalThis.__waiting=[f.event];globalThis.__recoveryGuard=guard;
 const oldFetch=globalThis.fetch;globalThis.fetch=async url=>Response.json(String(url).includes('access_token')?{access_token:'fixture'}:{messages:{data:[{id:'incoming',from:{id:'person'},message:'Please reply',attachments:{data:[]}}]}});
 t.after(()=>{globalThis.fetch=oldFetch;delete globalThis.__waiting;delete globalThis.__recoveryGuard;});f.env.META_IG_MESSAGING_TOKEN='fixture';
 const result=await dispatchDianaCloud(f.env,f.event.event_id,now,true);assert.equal(result.dispatched,true);assert.equal(f.created.length,1);
 const p=f.created[0];assert.notEqual(p.id,f.prior.workflow_id);assert.equal(p.params.event_id,f.event.event_id);assert.equal(p.params.recovery,true);assert.equal(p.params.recoveryAttempt,1);assert.equal(p.params.skipPayout,true);
 assert.equal(JSON.parse(f.db.prepare('SELECT value FROM crm_sync_state WHERE key=?').get('diana_cloud_event:'+f.event.event_id).value).status,'failed');
 assert.ok(f.db.prepare('SELECT value FROM crm_sync_state WHERE key=?').get('diana_recovery_skip_payout:'+f.event.event_id));
});
test('dispatcher does not probe or dispatch blocked original',async t=>{
 const f=await fixture(t);globalThis.__waiting=[f.event];globalThis.__recoveryGuard=guard;f.put('diana_event_done:'+f.event.event_id,{});
 t.after(()=>{delete globalThis.__waiting;delete globalThis.__recoveryGuard;});assert.equal((await dispatchDianaCloud(f.env,f.event.event_id,now,true)).dispatched,false);assert.equal(f.created.length,0);
});

for (const previousAttempt of [2,3]) test('recovery limit is enforced after attempt '+previousAttempt,async t=>{
 const f=await fixture(t);globalThis.__waiting=[f.event];globalThis.__recoveryGuard=guard;
 f.env.DIANA_CLOUD.get=async()=>({status:async()=>({status:'errored'})});
 f.put('diana_video_recovery_result:'+f.event.event_id,{status:'failed',reason:'recovery_technical_retryable',workflow_id:'direct-v1-'+'b'.repeat(64),recovery_attempt:previousAttempt,at:now-240000});
 const oldFetch=globalThis.fetch;globalThis.fetch=async url=>Response.json(String(url).includes('access_token')?{access_token:'fixture'}:{messages:{data:[{id:'incoming',from:{id:'person'},message:'Please reply',attachments:{data:[]}}]}});
 t.after(()=>{globalThis.fetch=oldFetch;delete globalThis.__waiting;delete globalThis.__recoveryGuard;});f.env.META_IG_MESSAGING_TOKEN='fixture';
 const result=await dispatchDianaCloud(f.env,f.event.event_id,now,true);
 assert.equal(result.dispatched,previousAttempt===2);
 assert.equal(f.created.length,previousAttempt===2?1:0);
 if(previousAttempt===2){assert.equal(f.created[0].params.recoveryAttempt,3);assert.equal(f.created[0].params.skipPayout,true);}
});
test('changed latest original never enters recovery',async t=>{
 const f=await fixture(t);globalThis.__waiting=[f.event];globalThis.__recoveryGuard=guard;
 const oldFetch=globalThis.fetch;globalThis.fetch=async url=>Response.json(String(url).includes('access_token')?{access_token:'fixture'}:{messages:{data:[{id:'newer-message',from:{id:'person'},message:'newer'}]}});
 t.after(()=>{globalThis.fetch=oldFetch;delete globalThis.__waiting;delete globalThis.__recoveryGuard;});f.env.META_IG_MESSAGING_TOKEN='fixture';
 assert.equal((await dispatchDianaCloud(f.env,f.event.event_id,now,true)).dispatched,false);assert.equal(f.created.length,0);
});
