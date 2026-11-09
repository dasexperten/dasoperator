import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createOperationalCapture } from './capture.mjs';
import { createPilotStore, sha256 } from './store.mjs';
import { createArticleQueue } from '../../workers/_social/article-queue.mjs';

const enc=new TextEncoder(), dec=new TextDecoder();
const config={namespace:'pilot-capture',agents:{angela:'shadow','diana-helios':'shadow'}};
const ghHash=body=>{const b=typeof body==='string'?enc.encode(body):body;return createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');};
const hash=body=>sha256(typeof body==='string'?enc.encode(body):body);
const PYTHON_GUARD=`import importlib.util,json,sys,socket,urllib.request,subprocess
def denied(*args,**kwargs):
    raise RuntimeError('Network and subprocess disabled for receipt parity')
socket.socket.connect=denied
socket.create_connection=denied
urllib.request.urlopen=denied
subprocess.run=denied
subprocess.Popen=denied
subprocess.check_output=denied
`;
function fixture(options={}) {
  const sql=new DatabaseSync(':memory:');sql.exec(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));
  const objects=new Map(), verified=[];
  const db={prepare(query){const s=sql.prepare(query);return{bind(...args){return{
    first:async()=>s.get(...args)??null,run:async()=>({success:true,meta:{changes:Number(s.run(...args).changes)}}),
  };}};}};
  const bucket={get:async key=>objects.has(key)?{size:objects.get(key).length,arrayBuffer:async()=>objects.get(key).slice().buffer}:null,
    put:async(key,b)=>{objects.set(key,new Uint8Array(b));}};
  const store=createPilotStore({config,db,bucket,authorize:async()=>true});
  const sourceVerifier=async request=>{verified.push(request);return true;};
  const capture=createOperationalCapture({config,store,sourceVerifier,...options});
  return{sql,objects,store,capture,verified,read:async r=>store.readSnapshot(r.manifest.agent_slug,r.manifest.manifest_id)};
}
async function github(body,changes={}) {return{agent:'angela',repository:'dasexperten/organizacia',commit:'a'.repeat(40),
  path:'agents/angela/MEMORY.md',gitBlobSha1:ghHash(body),expectedSha256:await hash(body),contentType:'text/plain; charset=utf-8',...changes};}
async function d1(body,changes={}) {return{agent:'angela',table:'org_task_runs',checkpoint:'consistent-export-01',expectedSha256:await hash(body),...changes};}

test('capture is an inert observer when flags are off', async()=>{
  const f=fixture({config:undefined});const body='memory';
  assert.deepEqual(await f.capture.captureGithubFile(await github(body),body),{skipped:'pilot_disabled',agent:'angela'});
  assert.equal(f.verified.length,0);assert.equal(f.objects.size,0);
});
test('GitHub memory writer verifies both hashes, preserves bytes and never returns a GitHub commit', async()=>{
  const f=fixture(),body='# MEMORY\r\n\n## [открытые дела]\nKeep exact text.\n';
  const r=await f.capture.captureGithubFile(await github(body),body);const saved=await f.read(r);
  assert.equal(dec.decode(saved.bytes),body);assert.equal(saved.manifest.kind,'working-memory');
  assert.equal(f.verified[0].verification.gitBlobSha1,ghHash(body));
  assert.equal(r.commit,undefined);assert.equal(r.sha,undefined);assert.equal(r.manifest.archive_only,1);
});
test('system rules, mixed LEARNING, code and other agents cannot enter operational writer', async()=>{
  const f=fixture();
  for(const path of ['agents/angela/CHARTER.md','agents/angela/LEARNING.md','agents/angela/data/tool.py',
    'agents/angela/data/README.md','agents/angela/data/CONNECTIONS.md','agents/angela/data/secret-token.json','agents/angela/social-outbox/secret-token.json',
    'agents/angela/social-outbox/LEARNING.md','agents/angela/social-outbox/.hidden.json',
    'agents/diana-helios/MEMORY.md','agents/angela/data/../MEMORY.md']){
    await assert.rejects(f.capture.captureGithubFile(await github('x',{path}),'x'),/requires_review|invalid_source_path/);
  }
  assert.equal(f.objects.size,0);
});
test('blob or content mismatch fails before source verifier and store', async()=>{
  const f=fixture();
  await assert.rejects(f.capture.captureGithubFile(await github('x',{gitBlobSha1:'0'.repeat(40)}),'x'),/git_blob_mismatch/);
  await assert.rejects(f.capture.captureGithubFile(await github('x',{expectedSha256:'0'.repeat(64)}),'x'),/capture_hash_mismatch/);
  assert.equal(f.verified.length,0);assert.equal(f.objects.size,0);
});
test('independent source verification is mandatory, not a source approval field', async()=>{
  for(const verifier of [undefined,async()=>false,async()=>({approved:true}),async()=>{throw Error('checkpoint unavailable');}]){
    const f=fixture({sourceVerifier:verifier});await assert.rejects(f.capture.captureGithubFile(await github('x'),'x'),/source_not_verified|checkpoint unavailable/);
    assert.equal(f.objects.size,0);
  }
  const f=fixture();await assert.rejects(f.capture.captureGithubFile(await github('x',{approved:true}),'x'),/invalid_capture_metadata/);
});
test('task runs preserve exported_at and status without marking source rows exported', async()=>{
  const f=fixture();f.sql.exec("CREATE TABLE org_task_runs(id INTEGER PRIMARY KEY,status TEXT,exported_at TEXT); INSERT INTO org_task_runs VALUES(7,'missed',NULL)");
  const body='{"id":7,"agent_slug":"angela","task_id":"T7","due_date":"2026-11-05","status":"missed","exported_at":null,"future_field":{"x":1}}\n';
  const r=await f.capture.captureD1Row(await d1(body),body);
  assert.equal(dec.decode((await f.read(r)).bytes),body);
  assert.equal(f.sql.prepare("SELECT count(*) AS n FROM org_task_runs WHERE status='missed' AND exported_at IS NULL").get().n,1);
  assert.equal((await f.capture.captureD1Row(await d1(body),body)).replay,true);
});
test('chat captures preserve channel, role, meta, original ID and distilled marker', async()=>{
  const f=fixture(), body='{"id":12,"agent_slug":"diana-helios","role":"user","channel":"telegram","content":"hello\\nworld","meta":"{\\"reply_id\\":4}","distilled_at":null}\n';
  const r=await f.capture.captureD1Row(await d1(body,{agent:'diana-helios',table:'agent_chat_messages'}),body);
  assert.equal(dec.decode((await f.read(r)).bytes),body);assert.equal(r.manifest.kind,'communication');
  assert.match(r.manifest.source_key,/agent_chat_messages\/12$/);
});
test('cross-agent rows, arbitrary tables and malformed checkpoint data fail closed', async()=>{
  const f=fixture(),row='{"id":1,"agent_slug":"someone","task_id":"t","due_date":"2026-11-05","status":"done"}';
  await assert.rejects(f.capture.captureD1Row(await d1(row),row),/source_agent_mismatch/);
  await assert.rejects(f.capture.captureD1Row(await d1(row,{table:'payments'}),row),/unsupported_source_table/);
  await assert.rejects(f.capture.captureD1Row(await d1('{bad'),'{bad'),/invalid_source_json/);
  assert.equal(f.objects.size,0);
});
test('missing source fields cannot be supplied through a polluted prototype', async()=>{
  const f=fixture(),body='{}';Object.prototype.id=7;Object.prototype.agent_slug='angela';
  try { await assert.rejects(f.capture.captureD1Row(await d1(body),body),/missing_source_fields/); }
  finally { delete Object.prototype.id;delete Object.prototype.agent_slug; }
  assert.equal(f.objects.size,0);
});
test('Angela active queue round trip preserves original baseline/version and existing status reader', async()=>{
  const f=fixture();const state={initializedAt:1720000000000,seen:['old','a'],articles:[{id:'a',status:'partial',payload:{approval:{approved:true,by:'roberta-di-maria'}},deliveries:{main:{status:'unknown',postId:'remote-6'},en:{status:'publishing',postId:'remote-7'}}}],lastBatchAt:1730000000000,lastSlot:'slot',pageLastAt:{en:1730000000000}};
  const row={id:1,version:42,data:JSON.stringify(state)};const body=JSON.stringify(row)+'\n';
  const r=await f.capture.captureD1Row(await d1(body,{table:'angela_article_queue'}),body);
  const restored=JSON.parse(dec.decode((await f.read(r)).bytes));assert.deepEqual(restored,row);
  let mutations=0;
  const q=createArticleQueue(null,{pages:{main:'1',en:'2',ar:'3',vi:'4'},store:{read:async()=>({version:restored.version,state:JSON.parse(restored.data)}),swap:async()=>{mutations++;throw Error('read only');}}});
  assert.deepEqual(await q.status(),state);
  await assert.rejects(q.tick(),/Publisher not configured/);assert.equal(mutations,0);
  // A separate local simulation checks existing anti-repost behavior, not only
  // the absent-publisher guard. No production queue or provider is involved.
  let sends=0,version=restored.version;
  const simulated=createArticleQueue(null,{pages:{main:'1',en:'2',ar:'3',vi:'4'},now:()=>Date.UTC(2026,10,5,8),
    publish:async()=>{sends++;throw Error('must not publish');},
    store:{read:async()=>({version,state:JSON.parse(restored.data)}),swap:async(v,next)=>{assert.equal(v,version);assert.deepEqual(next,state);version++;return true;}}});
  assert.match((await simulated.tick()).skipped,/reconciliation/);assert.equal(sends,0);
  assert.equal(r.manifest.kind,'queue-snapshot');assert.equal(r.manifest.archive_only,1);
});
test('Diana mixed action proofs remain distinct from byte-integrity receipts', {skip:!process.env.DIANA_RUNNER}, async()=>{
  const f=fixture();
  const receipt=handle=>({run_slot:'morning',handle,sent_at:'2026-11-05T08:00:00+04:00',first_contact:true,verified:true,proof_kind:'screenshot_readback',proof_url:`https://example.test/proof-${handle}`});
  const make=(handle,prefix,value)=>({id:'ugc_'+createHash('sha256').update('instagram:'+handle).digest('hex').slice(0,24),normalized_handle:handle,notes:prefix+' '+JSON.stringify(value)});
  const rows=[
    make('dm','DH_SCOUT_RECEIPT',receipt('dm')),
    make('unverified','DH_SCOUT_RECEIPT',{...receipt('unverified'),verified:false}),
    make('missing','DH_SCOUT_RECEIPT',{...receipt('missing'),proof_url:''}),
    make('comment','DH_SCOUT_COMMENT_RECEIPT',{...receipt('comment'),post_url:'https://www.instagram.com/p/example/',comment_text:'Observed example',observed_detail:'Fixture detail'}),
    make('reaction','DH_SCOUT_REACTION_RECEIPT',{...receipt('reaction'),reaction:'heart',verified_by:'Diana',source_creator:'fixture',source_post:'https://www.instagram.com/p/example/',source_comment:'Fixture comment'}),
  ];
  const after=[];
  for(const row of rows){const body=JSON.stringify(row);const r=await f.capture.captureD1Row(await d1(body,{agent:'diana-helios',table:'ugc_creators'}),body);after.push(JSON.parse(dec.decode((await f.read(r)).bytes)));}
  assert.deepEqual(after,rows);assert.equal(after[1].notes,rows[1].notes);
  const dir=mkdtempSync(join(tmpdir(),'diana-mixed-parity-'));
  try {
    const file=join(dir,'rows.json');writeFileSync(file,JSON.stringify({before:rows,after}));
    const py=PYTHON_GUARD+`spec=importlib.util.spec_from_file_location('runner',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nv=json.load(open(sys.argv[2]));a=m.counts_from_rows(v['before'],'2026-11-05');b=m.counts_from_rows(v['after'],'2026-11-05');assert a==b;assert (b['dm'],b['comments'],b['reactions'])==(1,1,1);print(json.dumps(b))`;
    const result=spawnSync('python3',['-c',py,process.env.DIANA_RUNNER,file],{encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
    assert.equal(result.status,0,result.stderr);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('outbox archival writer never turns approved content into an active queue item', async()=>{
  const f=fixture(),body='{"id":"a","approved":true,"status":"scheduled","publicationStatus":"live"}';
  const r=await f.capture.captureGithubFile(await github(body,{path:'agents/angela/social-outbox/a.json',contentType:'application/json'}),body);
  assert.equal(r.manifest.kind,'queue-snapshot');assert.equal(r.manifest.archive_only,1);
  assert.equal(dec.decode((await f.read(r)).bytes),body);
  assert.deepEqual(f.sql.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name),['pilot_operational_manifests']);
});
test('binary evidence capture preserves original source key without claiming outreach verified', async()=>{
  const f=fixture(),body=new Uint8Array([137,80,78,71,0,255]);
  const m={agent:'diana-helios',sourceType:'r2',sourceKey:'Existing/private/proof.png',revision:'version-1',expectedSha256:await hash(body),contentType:'image/png',originalUrl:'https://example.test/private/proof'};
  const r=await f.capture.captureEvidence(m,body);
  assert.deepEqual((await f.read(r)).bytes,body);assert.equal(r.manifest.source_key,m.sourceKey);
  assert.equal(r.manifest.verified,undefined);assert.equal(r.manifest.integrity_state,'bytes-verified');
  assert.ok([...f.objects.keys()].every(key=>key.startsWith('pilot-capture/')));
});
test('Diana note receipts round trip through existing parser without changing counts', {skip:!process.env.DIANA_RUNNER}, async()=>{
  const f=fixture();
  const receipt={run_slot:'morning',handle:'fixture',sent_at:'2026-11-05T08:00:00+04:00',first_contact:true,verified:true,proof_kind:'screenshot_readback',proof_url:'https://example.test/immutable-proof'};
  const creatorId='ugc_'+createHash('sha256').update('instagram:fixture').digest('hex').slice(0,24);
  const row={id:creatorId,normalized_handle:'fixture',notes:'DH_SCOUT_RECEIPT '+JSON.stringify(receipt)+'\nUnknown future note: unchanged'};
  const body=JSON.stringify(row);const r=await f.capture.captureD1Row(await d1(body,{agent:'diana-helios',table:'ugc_creators'}),body);
  const restored=JSON.parse(dec.decode((await f.read(r)).bytes));assert.deepEqual(restored,row);
  const dir=mkdtempSync(join(tmpdir(),'diana-parity-'));
  try {
    const file=join(dir,'rows.json');writeFileSync(file,JSON.stringify({before:[row],after:[restored]}));
    const py=PYTHON_GUARD+`spec=importlib.util.spec_from_file_location('runner',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nv=json.load(open(sys.argv[2]));a=m.counts_from_rows(v['before'],'2026-11-05');b=m.counts_from_rows(v['after'],'2026-11-05');assert a==b and b['dm']==1;print(json.dumps(b))`;
    const check=spawnSync('python3',['-c',py,process.env.DIANA_RUNNER,file],{encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
    assert.equal(check.status,0,check.stderr);assert.equal(JSON.parse(check.stdout).dm,1);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
