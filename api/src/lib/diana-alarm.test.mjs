import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
async function load(path) {
 const built=await build({entryPoints:[fileURLToPath(new URL(path,import.meta.url))],bundle:true,platform:'node',format:'esm',write:false});
 return import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
}
const {detectDianaMessages,dianaWindow}=await load('./diana-alarm.ts');
const {DianaWake}=await load('../diana-wake.ts');
const at=(hour,minute=0)=>Date.UTC(2026,10,6,hour-4,minute);
function fixture() {
 const state=new Map(), calls=[], dispatched=[];
 const env={DB:{prepare(sql){let params;const statement={bind(...p){params=p;return statement},
  async first(){return state.has(params[0])?{value:state.get(params[0])}:null},
  async run(){if(sql.includes("'diana_metadata_tick'")){if(state.has('tick')&&params[1]-state.get('tick')<180000)return {meta:{changes:0}};state.set('tick',params[1]);}
   else state.set(params[0],params[1]);return {meta:{changes:1}}},
  async all(){return {results:[...state].filter(([k])=>k.startsWith('diana_round_alarm:')).map(([,value])=>({value}))}}};return statement}},
  META_IG_MESSAGING_TOKEN:'fake',DIANA_WAKE:{idFromName:()=>1,get:()=>({async fetch(){dispatched.push(1);return Response.json({dispatched:true})}})}};
 const fetch=async(url,options)=>{calls.push([url,options]);const p=new URL(url);
  if(p.searchParams.get('fields')==='access_token')return Response.json({access_token:'page-fake'});
  if(p.pathname.endsWith('/conversations'))return Response.json({data:['one','two','three'].map(id=>({id,updated_time:'new'}))});
  const id=p.pathname.split('/').at(-1);return Response.json({participants:{data:[{id:'person-'+id,username:id}]},messages:{data:[{id:'message-'+id,created_time:'2026-11-06T15:00:00Z',from:{id:'person-'+id}}]}})};
 return {env,state,calls,dispatched,fetch};
}
test('Yerevan window includes 06:00 and 01:59, excludes 02:00 through 05:59',()=>{
 assert.equal(dianaWindow(at(6)),true);assert.equal(dianaWindow(at(1,59)),true);
 assert.equal(dianaWindow(at(2)),false);assert.equal(dianaWindow(at(5,59)),false);
});
test('three conversations produce metadata alarms and one dispatch without requesting text or attachments',async t=>{
 const f=fixture();t.mock.method(globalThis,'fetch',f.fetch);
 assert.equal((await detectDianaMessages(f.env,at(19))).detected,3);assert.equal(f.dispatched.length,1);
 for(const [url]of f.calls){const fields=new URL(url).searchParams.get('fields');assert.ok(!/(?:^|[,{}])message(?:[,}]|$)|attachments|shares|image|video/.test(fields));}
 const alarm=JSON.parse(f.state.get('diana_round_alarm:two'));
 assert.deepEqual(Object.keys(alarm).sort(),['at','cid','handle','message_id','rang_at','reason']);
 assert.equal((await detectDianaMessages(f.env,at(19,1))).not_due,true);
 await detectDianaMessages(f.env,at(19,3));assert.equal(f.dispatched.length,2);
 assert.equal([...f.state.keys()].some(k=>k.startsWith('ig_reply:')),false);
});
test('outside the window performs no Graph request or dispatch',async t=>{
 const f=fixture();t.mock.method(globalThis,'fetch',f.fetch);
 assert.equal((await detectDianaMessages(f.env,at(3))).outside_window,true);
 assert.equal(f.calls.length,0);assert.equal(f.dispatched.length,0);
});
test('all pending conversations wake only the highest connected machine; busy Diana is not launched twice',async()=>{
 const f=fixture();for(const cid of ['one','two','three'])f.state.set('diana_round_alarm:'+cid,JSON.stringify({cid,message_id:cid,at:'now'}));
 const peer=role=>({readyState:1,meta:{role,busy:false},sent:[],deserializeAttachment(){return this.meta},serializeAttachment(v){this.meta=v},send(v){this.sent.push(JSON.parse(v))}});
 const backup=peer('backup'),primary=peer('primary');const object=new DianaWake({getWebSockets:()=>[backup,primary]},f.env);
 await object.fetch(new Request('https://wake/dispatch'));assert.equal(primary.sent[0].messages.length,3);assert.equal(backup.sent.length,0);
 const second=await(await object.fetch(new Request('https://wake/dispatch'))).json();assert.equal(second.reason,'diana_working');assert.equal(primary.sent.length,1);
 object.webSocketMessage(primary,'{"type":"ready"}');assert.equal(primary.meta.busy,false);
});
