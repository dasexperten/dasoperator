import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {build} from 'esbuild';import {fileURLToPath} from 'node:url';
const b=await build({entryPoints:[fileURLToPath(new URL('./diana-round-owner-choices.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',write:false});const {collectOwnerChoices}=await import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].text).toString('base64'));
function fixture(t){const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE crm_sync_state(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER)');return{db,env:{DB:{prepare(sql){let a=[];return{bind(...v){a=v;return this},async first(){return db.prepare(sql).get(...a)??null},async run(){return{meta:{changes:Number(db.prepare(sql).run(...a).changes)}}}}}}}};}
test('a Diana button is preserved once and is not represented as executed',async t=>{const f=fixture(t);t.mock.method(globalThis,'fetch',async()=>Response.json({ok:true,items:[{agent_slug:'diana-helios',kind:'callback_query',reply_to_message_id:22,handled:1,update_id:1,text:'opt:1:yes'},{agent_slug:'other',kind:'callback_query',reply_to_message_id:23,update_id:2}]}));const a=await collectOwnerChoices(f.env,'run');await collectOwnerChoices(f.env,'run');assert.equal(a.count,1);assert.equal(a.status,'needs_review');const row=JSON.parse(f.db.prepare('SELECT value FROM crm_sync_state').get().value);assert.equal(row.reason,'original_question_and_action_not_verified');assert.equal(f.db.prepare('SELECT COUNT(*) n FROM crm_sync_state').get().n,1);});
test('a full page is never claimed to be a complete source',async t=>{const f=fixture(t);t.mock.method(globalThis,'fetch',async()=>Response.json({ok:true,items:Array.from({length:100},()=>({agent_slug:'other'}))}));assert.equal((await collectOwnerChoices(f.env,'run')).reason,'owner_choices_source_may_be_truncated');});
test('a choice linked to an exact stored question is queued once, not claimed delivered',async t=>{
 const f=fixture(t);f.db.exec("CREATE TABLE ugc_ig_messages(id TEXT,conversation_id TEXT,created_at TEXT,direction TEXT,from_username TEXT);INSERT INTO ugc_ig_messages VALUES('m','chat','2026-11-10T01:00:00Z','in','alice')");
 const q={cid:'chat',handle:'alice',at:'2026-11-10T01:00:00Z',options:{'Ответить':['Хорошо']}};f.db.prepare('INSERT INTO crm_sync_state VALUES(?,?,?)').run('ig_hard:22',JSON.stringify(q),1);
 f.env.DIANA_WAKE={idFromName(){return 1},get(){return{async fetch(){return Response.json({dispatched:false,reason:'round_busy'})}}}};
 t.mock.method(globalThis,'fetch',async()=>Response.json({ok:true,items:[{agent_slug:'diana-helios',kind:'callback_query',message_id:22,reply_to_message_id:null,handled:1,update_id:1,text:'opt:1:Ответить'}]}));
 const out=await collectOwnerChoices(f.env,'run');assert.equal(out.unresolved,1);
 const decisionAt=JSON.parse(f.db.prepare('SELECT value FROM crm_sync_state WHERE key=?').get('ig_hard:22').value).decision_at;
 await collectOwnerChoices(f.env,'run');assert.equal(JSON.parse(f.db.prepare('SELECT value FROM crm_sync_state WHERE key=?').get('ig_hard:22').value).decision_at,decisionAt);
 const item=JSON.parse(f.db.prepare('SELECT value FROM crm_sync_state WHERE key=?').get('diana_owner_choice:1').value);assert.equal(item.status,'queued');assert.equal(item.reason,'awaiting_verified_delivery');
 const action=JSON.parse(f.db.prepare("SELECT value FROM crm_sync_state WHERE key LIKE 'diana_action_pending:%'").get().value);assert.equal(action.task,'owner_choice');assert.equal(action.question_id,'22');
});
test('an old answered timestamp is not proof without the actual original delivery',async t=>{
 const f=fixture(t);f.db.exec("CREATE TABLE ugc_ig_messages(id TEXT,conversation_id TEXT,direction TEXT);INSERT INTO ugc_ig_messages VALUES('sent','chat','out')");
 const q={cid:'chat',handle:'alice',options:{'Ответить':['Хорошо']},choice:'Ответить',answered_at:'2026-11-10T01:00:00Z',delivery_key:'plan'};
 f.db.prepare('INSERT INTO crm_sync_state VALUES(?,?,?)').run('ig_hard:22',JSON.stringify(q),1);
 f.db.prepare('INSERT INTO crm_sync_state VALUES(?,?,?)').run('plan',JSON.stringify({conversationId:'chat',status:'complete',acknowledgedAt:1,items:[{status:'sent',messageId:'sent'}]}),1);
 f.env.META_IG_MESSAGING_TOKEN='test';let accessible=false;
 t.mock.method(globalThis,'fetch',async(url)=>String(url).includes('organizacia')?Response.json({ok:true,items:[{agent_slug:'diana-helios',kind:'callback_query',message_id:22,reply_to_message_id:null,handled:1,update_id:1,text:'opt:1:Ответить'}]}):String(url).includes('access_token')?Response.json({access_token:'page'}):accessible?Response.json({id:'sent',from:{id:'17841466350261166'}}):new Response('{}',{status:403}));
 let out=await collectOwnerChoices(f.env,'run');assert.equal(out.unresolved,1);let item=JSON.parse(f.db.prepare('SELECT value FROM crm_sync_state WHERE key=?').get('diana_owner_choice:1').value);assert.equal(item.reason,'owner_choice_delivery_unverified');
 accessible=true;out=await collectOwnerChoices(f.env,'run');assert.equal(out.unresolved,0);item=JSON.parse(f.db.prepare('SELECT value FROM crm_sync_state WHERE key=?').get('diana_owner_choice:1').value);assert.equal(item.reason,'owner_choice_delivery_verified');
});
test('an unhandled or incomplete Diana callback is not executed or silently ignored',async t=>{
 const f=fixture(t);t.mock.method(globalThis,'fetch',async()=>Response.json({ok:true,items:[{agent_slug:'diana-helios',kind:'callback_query',message_id:22,handled:0,update_id:3,text:'opt:1:Ответить'},{agent_slug:'diana-helios',kind:'callback_query',handled:1,update_id:4}]}));
 const out=await collectOwnerChoices(f.env,'run');assert.equal(out.count,2);assert.equal(out.unresolved,2);
 const item=JSON.parse(f.db.prepare('SELECT value FROM crm_sync_state WHERE key=?').get('diana_owner_choice:3').value);assert.equal(item.reason,'owner_callback_not_authenticated_or_handled');
});
test('old selected choice without a pending event is not replayed even when the original has a later outgoing message',async t=>{
 const f=fixture(t),q={cid:'chat',handle:'alice',options:{'Ответить':['Хорошо']},choice:'Ответить',decision_at:'2026-11-09T10:00:00Z'};
 f.db.prepare('INSERT INTO crm_sync_state VALUES(?,?,?)').run('ig_hard:22',JSON.stringify(q),1);f.env.META_IG_MESSAGING_TOKEN='test';let posts=0;
 t.mock.method(globalThis,'fetch',async(url,options)=>{if(options?.method==='POST')posts++;if(String(url).includes('organizacia'))return Response.json({ok:true,items:[{agent_slug:'diana-helios',kind:'callback_query',message_id:22,handled:1,update_id:1,text:'opt:1:Ответить'}]});if(String(url).includes('access_token'))return Response.json({access_token:'page'});return Response.json({data:[{id:'original-out',from:{id:'17841466350261166'},created_time:'2026-11-09T10:01:00Z'}]});});
 const a=await collectOwnerChoices(f.env,'run');await collectOwnerChoices(f.env,'run');assert.equal(a.unresolved,1);assert.equal(posts,0);
 const saved=JSON.parse(f.db.prepare('SELECT value FROM crm_sync_state WHERE key=?').get('diana_owner_choice:1').value);assert.equal(saved.reason,'prior_choice_delivery_unknown');assert.equal(saved.original_outgoing_count,1);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM crm_sync_state WHERE key LIKE 'diana_action_pending:%'").get().n,0);
});
