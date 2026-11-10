import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {build} from 'esbuild';import {fileURLToPath} from 'node:url';
const b=await build({stdin:{contents:"export {queueConfirmedPayoutNotice} from './ugc-payout-handoff.ts';export {queueDianaAction} from './diana-compose.ts';export {DianaWake,dianaBatch} from '../diana-wake.ts';",resolveDir:fileURLToPath(new URL('.',import.meta.url))},bundle:true,platform:'node',format:'esm',write:false});const {queueConfirmedPayoutNotice,queueDianaAction,DianaWake,dianaBatch}=await import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].text).toString('base64'));
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec(`CREATE TABLE crm_sync_state(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER);CREATE TABLE ugc_ig_messages(id TEXT,conversation_id TEXT,created_at TEXT,direction TEXT,from_username TEXT);INSERT INTO ugc_ig_messages VALUES('original','chat','2026-11-09T10:00:00Z','in','creator');CREATE TABLE ugc_payouts(id TEXT PRIMARY KEY,handle TEXT,status TEXT,konsol_payment_id TEXT,konsol_status TEXT,paid_at TEXT,failed_at TEXT,amount_minor INTEGER,currency TEXT,notice_status TEXT,paid_notice_at TEXT,notice_error TEXT,notice_at TEXT);INSERT INTO ugc_payouts VALUES('p1','creator','paid','provider1','executed','2026-11-09T12:00:00Z',NULL,45300,'RUB','sending','claim',NULL,NULL);`);
 const DB={prepare(sql){let p=[];return{bind(...v){p=v;return this},async first(){return db.prepare(sql).get(...p)??null},async all(){return{results:db.prepare(sql).all(...p)}},async run(){return{meta:{changes:db.prepare(sql).run(...p).changes}}}}},async batch(qs){db.exec('BEGIN');try{const r=[];for(const q of qs)r.push(await q.run());db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}}};
 const peer={readyState:1,meta:{role:'primary',busy:false,seen:Date.now()},sent:[],deserializeAttachment(){return this.meta},serializeAttachment(v){this.meta=v},send(v){this.sent.push(JSON.parse(v))},close(){this.readyState=3}};
 const values=new Map(),alarms=[];const storage={async put(k,v){values.set(k,v)},async get(k){return values.get(k)},async delete(k){values.delete(k)},async setAlarm(at){alarms.push(at)}};
 const env={DB};const actor=new DianaWake({getWebSockets:()=>[peer],storage},env);env.DIANA_WAKE={idFromName:()=>1,get:()=>({fetch:(url,init)=>actor.fetch(new Request(url,init))})};return{db,env,peer,actor,alarms};
}
const events=f=>f.db.prepare("SELECT value FROM crm_sync_state WHERE key LIKE 'diana_action_pending:%'").all().map(r=>JSON.parse(r.value));
test('a finished cloud workflow schedules a durable retry and dispatches paid notice when it becomes terminal',async t=>{
 t.mock.method(Date,'now',()=>Date.parse('2026-11-10T12:00:00+03:00'));
 const f=fixture(t),instances=new Map([['direct-old','running']]),created=[];
 f.db.prepare('INSERT INTO crm_sync_state VALUES(?,?,?)').run('diana_cloud_mode','enabled',Date.now());
 f.db.prepare('INSERT INTO crm_sync_state VALUES(?,?,?)').run('diana_cloud_active','direct-old',Date.now());
 f.env.DIANA_CLOUD={async get(id){return{async status(){if(!instances.has(id))throw Error('not found');return{status:instances.get(id)}}}},async create({id,params}){created.push({id,params});instances.set(id,'running')}};
 const out=await queueConfirmedPayoutNotice(f.env,'p1','paid');assert.equal(out.dispatch.reason,'diana_cloud_working');assert.equal(events(f).length,1);
 await f.actor.fetch(new Request('https://wake/cloud-released',{method:'POST'}));assert.equal(f.alarms.length,1);
 await f.actor.alarm();assert.equal(f.alarms.length,2);assert.equal(created.length,0);
 // The old workflow's final step has finished every action and atomically
 // released the lock, even if the platform still reports it as running.
 f.db.prepare('INSERT INTO crm_sync_state VALUES(?,?,?)').run('diana_cloud_finished:direct-old',JSON.stringify({kind:'direct',id:'direct-old'}),Date.now());
 await f.actor.alarm();assert.equal(created.length,1);assert.equal(created[0].params.task,'payout_paid_notice');
});
test('canonical paid facts durably queue then immediately wake once; dispatch is not delivery',async t=>{
 const f=fixture(t),a=await queueConfirmedPayoutNotice(f.env,'p1','paid');assert.equal(a.dispatch.dispatched,true);const [e]=events(f);assert.equal(e.task,'payout_paid_notice');assert.equal(e.paid_at,'2026-11-09T12:00:00Z');assert.equal(e.payout_id,'p1');assert.equal(e.amount_minor,45300);assert.equal(Object.hasOwn(e,'text'),false);assert.equal(f.peer.sent.length,1);
 const receipt=JSON.parse(f.db.prepare("SELECT value FROM crm_sync_state WHERE key=?").get('diana_wake_dispatch:'+e.event_id).value);assert.equal(receipt.status,'pushed_to_machine');assert.equal(receipt.peer_role,'primary');assert.ok(Date.parse(receipt.dispatched_at)>=Date.parse(e.at));
 assert.equal((await queueConfirmedPayoutNotice(f.env,'p1','paid')).dispatch.reason,'diana_working');assert.equal(events(f).length,1);assert.equal(f.peer.sent.length,1);const p=f.db.prepare('SELECT * FROM ugc_payouts').get();assert.equal(p.notice_status,'queued');assert.equal(p.paid_notice_at,null);
 f.db.exec("UPDATE ugc_payouts SET notice_status='delivered'");assert.equal((await queueConfirmedPayoutNotice(f.env,'p1','paid')).completed,true);assert.equal(f.peer.sent.length,1);
});
test('failed notice uses actual failed_at and never fabricates paid_at or repeats a delivered notice',async t=>{
 const f=fixture(t);f.db.exec("UPDATE ugc_payouts SET status='failed',konsol_status='failed',paid_at=NULL,failed_at='2026-11-09T12:05:00Z'");await queueConfirmedPayoutNotice(f.env,'p1','failed');const [e]=events(f);assert.equal(e.task,'payout_failed_notice');assert.equal(e.failed_at,'2026-11-09T12:05:00Z');assert.equal(Object.hasOwn(e,'paid_at'),false);
 f.db.exec("UPDATE ugc_payouts SET notice_status='delivered'");assert.equal((await queueConfirmedPayoutNotice(f.env,'p1','failed')).completed,true);assert.equal(f.peer.sent.length,1);
});
test('unconfirmed paid status cannot queue a money-arrived claim',async t=>{
 const f=fixture(t);f.db.exec("UPDATE ugc_payouts SET status='sent',konsol_status='processing',paid_at=NULL");await assert.rejects(queueConfirmedPayoutNotice(f.env,'p1','paid'),/confirmed_paid/);assert.equal(events(f).length,0);assert.equal(f.peer.sent.length,0);
});
test('legacy event is enriched without changing identity or original queue time',async t=>{
 const f=fixture(t);f.peer.meta.busy=true;const old=await queueDianaAction(f.env,'creator','','payout:p1:paid');const before=events(f)[0];f.peer.meta.busy=false;const enriched=await queueConfirmedPayoutNotice(f.env,'p1','paid');const [e]=events(f);assert.equal(e.event_id,old.eventId);assert.equal(enriched.eventId,old.eventId);assert.equal(e.at,before.at);assert.equal(e.message_id,before.message_id);assert.equal(e.task,'payout_paid_notice');assert.equal(f.peer.sent.length,1);
});
test('global round claim defers wake; ready dispatches after expiry without deleting or resetting the claim',async t=>{
 const f=fixture(t);f.db.prepare('INSERT INTO crm_sync_state VALUES(?,?,?)').run('diana_round_claim','other-owner',Date.now());const a=await queueConfirmedPayoutNotice(f.env,'p1','paid');assert.equal(a.dispatch.reason,'diana_round_running');assert.equal(f.peer.sent.length,0);
 await f.actor.webSocketMessage(f.peer,JSON.stringify({type:'ready'}));assert.equal(f.peer.sent.length,0);f.db.prepare('UPDATE crm_sync_state SET updated_at=? WHERE key=?').run(Date.now()-180001,'diana_round_claim');await f.actor.webSocketMessage(f.peer,JSON.stringify({type:'ready'}));assert.equal(f.peer.sent.length,1);assert.equal(f.db.prepare("SELECT value FROM crm_sync_state WHERE key='diana_round_claim'").get().value,'other-owner');
});
test('ready immediately takes a new paid event, without a hot loop on the unacknowledged prior batch',async t=>{
 const f=fixture(t);const old={event_id:'message:old',message_id:'old',cid:'chat',handle:'creator',at:'2026-11-09T11:00:00Z'};f.db.prepare('INSERT INTO crm_sync_state VALUES(?,?,?)').run('diana_round_alarm:chat',JSON.stringify(old),1);await f.actor.fetch(new Request('https://wake/dispatch'));assert.equal(f.peer.sent.length,1);await queueConfirmedPayoutNotice(f.env,'p1','paid');assert.equal(f.peer.sent.length,1);await f.actor.webSocketMessage(f.peer,JSON.stringify({type:'ready'}));assert.equal(f.peer.sent.length,2);assert.equal(f.peer.sent[1].messages[0].task,'payout_paid_notice');for(let i=0;i<5;i++)await f.actor.webSocketMessage(f.peer,JSON.stringify({type:'ready'}));assert.equal(f.peer.sent.length,2);
});
test('financial notices have default priority while explicit new-chat priority and remaining chat order survive',()=>{
 const rows=[{event_id:'message:new',at:'2099-01-01',last_from_us:false},{event_id:'action:paid',task:'payout_paid_notice',at:'2026-01-01'},{event_id:'action:failed',task:'payout_failed_notice',at:'2026-01-02'}];assert.equal(dianaBatch(rows)[0].event_id,'action:failed');assert.equal(dianaBatch(rows,'message:new')[0].event_id,'message:new');
});

test('Owner Direct-only mode pauses other actions durably and never routes to Air',async t=>{
 const f=fixture(t);f.db.prepare('INSERT INTO crm_sync_state VALUES(?,?,?)').run('diana_execution_mode','direct_only_primary',Date.now());
 const a=await queueConfirmedPayoutNotice(f.env,'p1','paid');assert.equal(a.dispatch.dispatched,false);assert.equal(f.peer.sent.length,0);assert.equal(events(f).length,1);
 const msg={event_id:'message:direct',message_id:'direct',cid:'chat',handle:'creator',at:'2026-11-09T11:00:00Z'};
 f.db.prepare('INSERT INTO crm_sync_state VALUES(?,?,?)').run('diana_round_alarm:chat',JSON.stringify(msg),1);
 f.peer.meta.role='secondary';const paused=await (await f.actor.fetch(new Request('https://wake/dispatch'))).json();assert.equal(paused.reason,'no_machine_connected');assert.equal(f.peer.sent.length,0);
 f.peer.meta.role='primary';await f.actor.fetch(new Request('https://wake/dispatch'));assert.equal(f.peer.sent.length,1);assert.deepEqual(f.peer.sent[0].messages.map(x=>x.event_id),['message:direct']);assert.equal(events(f).length,1);
});
