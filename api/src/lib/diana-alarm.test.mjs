import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
async function load(path){const b=await build({entryPoints:[fileURLToPath(new URL(path,import.meta.url))],bundle:true,platform:'node',format:'esm',write:false});return import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].text).toString('base64'))}
const {detectDianaMessages,dianaWindow,acknowledgeDianaEvent,pendingDianaMessages}=await load('./diana-alarm.ts');
const {DianaWake}=await load('../diana-wake.ts');
const at=(h,m=0,s=0)=>Date.UTC(2026,10,6,h-4,m,s);
function fixture(){
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE crm_sync_state(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER)');
 const state={get:k=>db.prepare('SELECT value FROM crm_sync_state WHERE key=?').get(k)?.value,set:(k,v)=>db.prepare('INSERT OR REPLACE INTO crm_sync_state VALUES(?,?,0)').run(k,v)};
 const calls=[],dispatched=[];
 const DB={prepare(sql){let p=[];const st={bind(...a){p=a;return st},async first(){return db.prepare(sql).get(...p)??null},async run(){return {meta:{changes:db.prepare(sql).run(...p).changes}}},async all(){return {results:db.prepare(sql).all(...p)}}};return st},async batch(st){db.exec('BEGIN');try{const r=[];for(const s of st)r.push(await s.run());db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}}};
 const env={DB,META_IG_MESSAGING_TOKEN:'fake',DIANA_WAKE:{idFromName:()=>1,get:()=>({async fetch(){dispatched.push(1);return Response.json({dispatched:true})}})}};
 const fetch=async(url)=>{calls.push(url);const p=new URL(url);if(p.searchParams.get('fields')==='access_token')return Response.json({access_token:'fake'});if(p.pathname.endsWith('/conversations'))return Response.json({data:['one','two','three'].map(id=>({id,updated_time:'new'}))});const id=p.pathname.split('/').at(-1);return Response.json({participants:{data:[{id:'person-'+id,username:id}]},messages:{data:[{id:'message-'+id,created_time:'2026-11-06T15:00:00Z',from:{id:'person-'+id}}]}})};
 return {env,state,calls,dispatched,fetch,db};
}
test('Yerevan window 06 inclusive to 02 exclusive',()=>{assert.ok(dianaWindow(at(6)));assert.ok(dianaWindow(at(1,59)));assert.ok(!dianaWindow(at(2)));assert.ok(!dianaWindow(at(5,59)))});
test('outside window makes no request',async t=>{const f=fixture();t.after(()=>f.db.close());t.mock.method(globalThis,'fetch',f.fetch);assert.ok((await detectDianaMessages(f.env,at(3))).outside_window);assert.equal(f.calls.length,0)});
test('Graph outage still dispatches durable pending queue',async t=>{const f=fixture();t.after(()=>f.db.close());t.mock.method(globalThis,'fetch',async()=>new Response('',{status:503}));assert.equal((await detectDianaMessages(f.env,at(19))).errors,1);assert.equal(f.dispatched.length,1)});
test('all pending go to highest peer once while busy',async t=>{const f=fixture();t.after(()=>f.db.close());for(const cid of ['one','two','three'])f.state.set('diana_round_alarm:'+cid,JSON.stringify({cid,message_id:cid,event_id:'message:'+cid}));const peer=role=>({readyState:1,meta:{role,busy:false},sent:[],deserializeAttachment(){return this.meta},serializeAttachment(v){this.meta=v},send(v){this.sent.push(JSON.parse(v))}});const backup=peer('backup'),primary=peer('primary');const o=new DianaWake({getWebSockets:()=>[backup,primary]},f.env);await o.fetch(new Request('https://wake/dispatch'));assert.equal(primary.sent[0].messages.length,3);assert.equal(backup.sent.length,0);assert.equal((await(await o.fetch(new Request('https://wake/dispatch'))).json()).reason,'diana_working')});
test('cloud-only instruction preserves pending messages and never dispatches them to a connected computer',async t=>{const f=fixture();t.after(()=>f.db.close());f.state.set('diana_machine_dispatch','disabled');f.state.set('diana_round_alarm:chat',JSON.stringify({cid:'chat',message_id:'m',event_id:'message:m'}));const peer={readyState:1,meta:{role:'primary',busy:false},sent:[],deserializeAttachment(){return this.meta},serializeAttachment(v){this.meta=v},send(v){this.sent.push(v)}};const o=new DianaWake({getWebSockets:()=>[peer]},f.env);const out=await(await o.fetch(new Request('https://wake/dispatch'))).json();assert.equal(out.reason,'cloud_direct_unavailable');assert.equal(peer.sent.length,0);assert.ok(f.state.get('diana_round_alarm:chat'))});
test('ACK requires exact verified event proof; old reply cannot complete a new action',async t=>{const f=fixture();t.after(()=>f.db.close());const e={cid:'chat',message_id:'old',event_id:'action:payout'};const key='diana_action_pending:'+e.event_id;f.state.set(key,JSON.stringify(e));f.state.set('ig_reply:chat','2099');assert.equal(await acknowledgeDianaEvent(f.env,e),false);f.state.set('diana_event_done:'+e.event_id,JSON.stringify({...e,verified:true,proof:'reopened sent message'}));assert.equal(await acknowledgeDianaEvent(f.env,e),true);assert.equal(f.state.get(key),undefined);assert.equal(f.state.get('diana_message_done:chat'),undefined)});
test('ACK older incoming preserves newer alarm and done checkpoint',async t=>{const f=fixture();t.after(()=>f.db.close());const e={cid:'chat',message_id:'old',event_id:'message:old'};f.state.set('diana_round_alarm:chat',JSON.stringify({...e,message_id:'new',event_id:'message:new'}));f.state.set('diana_event_done:'+e.event_id,JSON.stringify({...e,verified:true,proof:'verified'}));assert.equal(await acknowledgeDianaEvent(f.env,e),false);assert.equal(f.state.get('diana_message_done:chat'),undefined);assert.equal(JSON.parse(f.state.get('diana_round_alarm:chat')).message_id,'new');f.state.set('diana_round_alarm:chat',JSON.stringify(e));assert.equal(await acknowledgeDianaEvent(f.env,e),true);assert.equal(f.state.get('diana_message_done:chat'),'old')});

test('legacy signals retain unknown IDs, get durable identity and cannot close newer incoming',async t=>{const f=fixture();t.after(()=>f.db.close());f.state.set('diana_round_alarm:legacy',JSON.stringify({handle:'creator',at:'old'}));const [e]=await pendingDianaMessages(f.env);assert.equal(e.cid,'legacy');assert.equal(e.message_id,null);assert.ok(e.event_id.startsWith('legacy:'));assert.equal((await pendingDianaMessages(f.env))[0].event_id,e.event_id);f.state.set('diana_event_done:'+e.event_id,JSON.stringify({...e,verified:true,proof:'original reviewed; already handled'}));assert.equal(await acknowledgeDianaEvent(f.env,e),true);assert.equal(f.state.get('diana_message_done:legacy'),undefined)});

test('batch metadata avoids a Graph request per conversation; active scan prevents overlap',async t=>{const f=fixture();t.after(()=>f.db.close());let calls=0;t.mock.method(globalThis,'fetch',async u=>{calls++;const p=new URL(u);if(p.pathname.endsWith('/conversations'))return Response.json({data:Array.from({length:25},(_,i)=>({id:'b'+i,updated_time:'new',messages:{data:[{id:'m'+i,created_time:'now',from:{id:'p'+i,username:'u'+i}}]}}))});return f.fetch(u)});assert.equal((await detectDianaMessages(f.env,at(19))).detected,25);assert.equal(calls,2);f.state.set('diana_metadata_scan','other');f.db.prepare('UPDATE crm_sync_state SET updated_at=? WHERE key=?').run(Date.now(),'diana_metadata_scan');assert.ok((await detectDianaMessages(f.env,at(19,3))).scan_running);assert.equal(calls,2)});

// Owner 2026-11-09: ERP scans metadata for the newest 200 chats.
function chatsFetch(f, chats, seen = {}) {
  return async u => {
    f.calls.push(String(u)); const p = new URL(u);
    if (p.searchParams.get('fields') === 'access_token') return Response.json({ access_token: 'fake' });
    if (p.pathname.endsWith('/conversations')) {
      const after = Number(p.searchParams.get('after') || 0); const page = chats.slice(after, after + 25);
      return Response.json({ data: page, paging: after + 25 < chats.length ? { next: 'x', cursors: { after: String(after + 25) } } : {} });
    }
    return new Response('', { status: 404 });
  };
}
const chat = (id, lastFrom, t = '2026-11-06T10:00:00+0000') => ({ id, updated_time: t, participants: { data: [{ id: 'u' + id, username: 'user' + id }] },
  messages: { data: [{ id: 'm' + id, created_time: t, from: { id: lastFrom === 'us' ? '17841466350261166' : 'u' + id, username: lastFrom === 'us' ? 'dasexperten' : 'user' + id } }] } });
test('scan looks at the newest 200 chats only, never deeper', async t => {
  const f = fixture(); t.after(() => f.db.close());
  const chats = Array.from({ length: 240 }, (_, i) => chat('c' + i, 'them'));
  t.mock.method(globalThis, 'fetch', chatsFetch(f, chats));
  const r = await detectDianaMessages(f.env, at(12));
  assert.equal(r.inspected, 200); assert.equal(f.calls.filter(u => u.includes('/conversations')).length, 8);
  assert.ok(!f.state.get('diana_round_alarm:c200')); assert.ok(f.state.get('diana_round_alarm:c199'));
});
test('alarm only when the newest message is incoming; our last message clears the alarm', async t => {
  const f = fixture(); t.after(() => f.db.close());
  f.state.set('diana_round_alarm:answered', JSON.stringify({ handle: 'a', cid: 'answered', message_id: 'old', event_id: 'message:old', at: 'x' }));
  t.mock.method(globalThis, 'fetch', chatsFetch(f, [chat('waiting', 'them'), chat('answered', 'us')]));
  const r = await detectDianaMessages(f.env, at(12));
  assert.equal(r.detected, 1); assert.ok(f.state.get('diana_round_alarm:waiting')); assert.equal(f.state.get('diana_round_alarm:answered'), undefined);
  assert.equal(JSON.parse(f.state.get('diana_round_alarm:waiting')).event_id, 'message:mwaiting');
});
test('alarms outside the scan remain pending; nothing new in a chat raises nothing twice', async t => {
  const f = fixture(); t.after(() => f.db.close());
  f.db.prepare('INSERT INTO crm_sync_state VALUES(?,?,?)').run('diana_round_alarm:ancient', JSON.stringify({ cid: 'ancient', event_id: 'message:z' }), 1);
  t.mock.method(globalThis, 'fetch', chatsFetch(f, [chat('fresh', 'them')]));
  await detectDianaMessages(f.env, at(12));
  assert.ok(f.state.get('diana_round_alarm:ancient')); assert.ok(f.state.get('diana_round_alarm:fresh'));
  const second = await detectDianaMessages(f.env, at(12, 4));
  assert.equal(second.detected, 0);
});
test('dispatch carries the newest 50 identifiers only', async t => {
  const { dianaBatch } = await load('../diana-wake.ts');
  const many = Array.from({ length: 300 }, (_, i) => ({ cid: 'c' + i, message_id: 'm' + i, event_id: 'message:m' + i, handle: 'h', at: new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString(), reason: 'new_message', queue_key: 'k' + i, text: 'must not travel' }));
  const batch = dianaBatch(many);
  assert.equal(batch.length, 50); assert.equal(batch[0].cid, 'c299'); assert.ok(!('text' in batch[0])); assert.equal(batch[0].handle, 'h');
});

test('state, not news: a waiting chat missed once is raised again; a receipt for that message closes it', async t => {
  const f = fixture(); t.after(() => f.db.close());
  // Old event markers from the news-based alarm must not hide a chat that is still waiting.
  f.state.set('diana_metadata_message_seen:old', 'mold');
  f.state.set('diana_message_done:closed', 'mclosed');
  t.mock.method(globalThis, 'fetch', chatsFetch(f, [chat('old', 'them', '2026-11-05T10:00:00+0000'), chat('closed', 'them')]));
  const r = await detectDianaMessages(f.env, at(12));
  assert.equal(r.detected, 1); assert.ok(f.state.get('diana_round_alarm:old')); assert.equal(f.state.get('diana_round_alarm:closed'), undefined);
  const first = JSON.parse(f.state.get('diana_round_alarm:old')).rang_at;
  f.db.prepare('DELETE FROM crm_sync_state WHERE key=?').run('diana_metadata_tick_v2');
  const again = await detectDianaMessages(f.env, at(12, 4));
  assert.equal(again.detected, 0); assert.equal(JSON.parse(f.state.get('diana_round_alarm:old')).rang_at, first);
  f.state.set('diana_round_alarm:old', 'gone'); f.db.prepare('DELETE FROM crm_sync_state WHERE key=?').run('diana_round_alarm:old');
  f.db.prepare('DELETE FROM crm_sync_state WHERE key=?').run('diana_metadata_tick_v2');
  assert.equal((await detectDianaMessages(f.env, at(12, 8))).detected, 1); // lost alarm comes back while the chat waits
});

test('video reminders wait for the 07:00 batch while other alarms stay available', async t => {
  const f=fixture(); t.after(()=>f.db.close());
  f.state.set('diana_action_pending:video',JSON.stringify({cid:'v',message_id:'v',event_id:'action:video',task:'video_reminder'}));
  f.state.set('diana_action_pending:payout',JSON.stringify({cid:'p',message_id:'p',event_id:'action:payout'}));
  assert.deepEqual((await pendingDianaMessages(f.env,at(6,59))).map(x=>x.cid),['p']);
  f.state.set('diana_video_reminder_batch_day','2026-11-06');
  assert.deepEqual((await pendingDianaMessages(f.env,at(7))).map(x=>x.cid).sort(),['p','v']);
  assert.deepEqual((await pendingDianaMessages(f.env,at(24))).map(x=>x.cid),['p']);
});

test('an old-rule reminder stays pending but is not delivered before five full days', async t => {
  const f=fixture(); t.after(()=>f.db.close());
  f.state.set('diana_action_pending:video',JSON.stringify({cid:'v',message_id:'v',event_id:'action:video',task:'video_reminder',paid_at:'2026-11-04T03:00:00.000Z'}));
  f.state.set('diana_video_reminder_batch_day','2026-11-09');
  assert.equal((await pendingDianaMessages(f.env,Date.parse('2026-11-09T02:59:59.000Z'))).length,0);
  assert.equal((await pendingDianaMessages(f.env,Date.parse('2026-11-09T03:00:00.000Z'))).length,1);
  assert.ok(f.state.get('diana_action_pending:video'));
});


test('detected account name and handle are handed to Diana; missing names stay unknown', async t => {
  const f=fixture(); t.after(()=>f.db.close());
  const named=chat('named','them'); named.messages.data[0].from.name='Creator Name';
  const unknown=chat('unknown','them'); delete unknown.messages.data[0].from.username; unknown.participants.data[0]={id:'uunknown'};
  t.mock.method(globalThis,'fetch',chatsFetch(f,[named,unknown]));
  await detectDianaMessages(f.env,at(12));
  const {dianaBatch}=await load('../diana-wake.ts');
  const result=dianaBatch(await pendingDianaMessages(f.env));
  const a=result.find(x=>x.cid==='named'), b=result.find(x=>x.cid==='unknown');
  assert.equal(a.handle,'usernamed'); assert.equal(a.display_name,'Creator Name');
  assert.equal(b.handle,''); assert.equal(b.display_name,'');
});


test('each newly detected chat is dispatched before scanning the next page and a busy peer leaves it queued', async t => {
  const f=fixture(); t.after(()=>f.db.close());
  let pages=0, dispatches=0;
  f.env.DIANA_WAKE.get=()=>({async fetch(){dispatches++; assert.ok(f.state.get('diana_round_alarm:early')); return Response.json({dispatched:false,reason:'diana_working'})}});
  t.mock.method(globalThis,'fetch',async u=>{const p=new URL(u); if(p.searchParams.get('fields')==='access_token')return Response.json({access_token:'fake'});
    pages++; if(pages===1)return Response.json({data:[chat('early','them')],paging:{next:'x',cursors:{after:'25'}}});
    assert.ok(dispatches>=1, 'first signal sent before requesting the next page'); return Response.json({data:[]});});
  const result=await detectDianaMessages(f.env,at(12));
  assert.equal(result.inspected,1); assert.equal(result.detected,1); assert.equal(result.early_dispatched,0);
  assert.equal(dispatches,2); assert.ok(f.state.get('diana_round_alarm:early'));
});

test('a failed immediate handoff does not stop the scan or remove its signal', async t => {
  const f=fixture();t.after(()=>f.db.close());let calls=0;
  f.env.DIANA_WAKE.get=()=>({async fetch(){if(++calls===1) throw new Error('offline'); return Response.json({dispatched:true})}});
  t.mock.method(globalThis,'fetch',chatsFetch(f,[chat('early','them'),chat('later','them')]));
  const result=await detectDianaMessages(f.env,at(12));
  assert.equal(result.inspected,2); assert.equal(result.detected,2); assert.equal(result.errors,1);
  assert.ok(f.state.get('diana_round_alarm:early')); assert.ok(f.state.get('diana_round_alarm:later'));
});


test('a freshly detected event reaches Diana even when a larger newer backlog exists',async()=>{
  const {dianaBatch}=await load('../diana-wake.ts');
  const pending=Array.from({length:90},(_,i)=>({cid:'c'+i,event_id:'message:'+i,at:new Date(Date.UTC(2026,10,8,0,0,i)).toISOString()}));
  const selected=dianaBatch(pending,'message:0');
  assert.equal(selected.length,50); assert.equal(selected[0].event_id,'message:0');
});

test('an existing unanswered signal is dispatched during the scan without waiting for the final page', async t => {
  const f=fixture();t.after(()=>f.db.close());
  f.state.set('diana_round_alarm:waiting', JSON.stringify({cid:'waiting',message_id:'mwaiting',event_id:'message:mwaiting'}));
  let sends=0, pages=0;
  f.env.DIANA_WAKE.get=()=>({async fetch(){sends++;return Response.json({dispatched:false,reason:'diana_working'})}});
  t.mock.method(globalThis,'fetch',async u=>{const p=new URL(u);if(p.searchParams.get('fields')==='access_token')return Response.json({access_token:'fake'});pages++;if(pages===1)return Response.json({data:[chat('waiting','them')],paging:{next:'x',cursors:{after:'25'}}});assert.ok(sends>0);return Response.json({data:[]})});
  const result=await detectDianaMessages(f.env,at(12));assert.equal(result.detected,0);assert.equal(sends,2);assert.ok(f.state.get('diana_round_alarm:waiting'));
});

test('priority dispatch sends the found chat first and skips queue reads when Diana is busy',async t=>{
  const f=fixture();t.after(()=>f.db.close());
  for(let i=0;i<55;i++) f.state.set('diana_round_alarm:c'+i,JSON.stringify({cid:'c'+i,message_id:'m'+i,event_id:'message:m'+i,at:new Date(Date.UTC(2026,10,1,0,0,i)).toISOString()}));
  const peer={readyState:1,meta:{role:'primary',busy:false},sent:[],deserializeAttachment(){return this.meta},serializeAttachment(v){this.meta=v},send(v){this.sent.push(JSON.parse(v))}};
  const o=new DianaWake({getWebSockets:()=>[peer]},f.env);
  const request=()=>new Request('https://wake/dispatch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({priority_event_id:'message:m0'})});
  const first=await (await o.fetch(request())).json(); assert.equal(first.dispatched,true);assert.equal(peer.sent[0].messages[0].event_id,'message:m0');
  const saved=f.env.DB;f.env.DB={prepare(sql){if(sql.includes("key='diana_execution_mode'"))return{async first(){return null}};throw new Error('queue should not be read while busy')}};
  const second=await (await o.fetch(request())).json();assert.equal(second.reason,'diana_working');f.env.DB=saved;
});
