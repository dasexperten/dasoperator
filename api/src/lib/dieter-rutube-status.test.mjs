import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {reconcileDieterRutubeStatus} from './dieter-rutube-status.ts';
const videoId='4d04ae2c27605cf6ddb59664c308cc82',sha='c3a0b015eca292fce063b9ed3de8f659126461a1656bb0420793d0780b2f1242',caption='Original creator caption #verified';
const args={contentId:'content',claimId:'claim'};
function fixture(t,options={}){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE crm_sync_state(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER);CREATE TABLE ugc_content(id TEXT PRIMARY KEY,content_url TEXT);CREATE TABLE ugc_reel_jobs(content_id TEXT PRIMARY KEY,status TEXT,claim_id TEXT,publications TEXT,updated_at TEXT)');
 const prior=[{platform:'instagram',url:'https://www.instagram.com/reel/ExistingFixture/'}];
 db.prepare('INSERT INTO ugc_content VALUES(?,?)').run('content','https://www.instagram.com/reel/OriginalFixture/');db.prepare('INSERT INTO ugc_reel_jobs VALUES(?,?,?,?,?)').run('content','working','claim',JSON.stringify(prior),'old');
 const save=(key,value)=>db.prepare('INSERT INTO crm_sync_state VALUES(?,?,0)').run(key,JSON.stringify(value));
 save('ugc-rutube-pending:content:claim',{video_id:videoId,source_sha256:sha,duration_seconds:12.733});save('ugc-caption-plan:content:claim',{content_id:'content',platforms:{rutube:{caption}}});
 const env={DB:{
  prepare(sql){let values=[];return {
   bind(...v){values=v;return this;},
   async first(){return db.prepare(sql).get(...values)??null;},
   async run(){
    if(sql.startsWith('UPDATE ugc_reel_jobs SET publications')){
     assert.ok(db.prepare("SELECT value FROM crm_sync_state WHERE key LIKE 'ugc-rutube-public-proof:%'").get(),'public proof must be durable BEFORE ERP CAS');
     if(options.conflict)return {meta:{changes:0}};
    }
    return {meta:{changes:Number(db.prepare(sql).run(...values).changes)}};
   }
  };}
 }};
 const paths=[];
 const fetchImpl=async(u,init)=>{
  const url=new URL(u);paths.push(url.pathname);assert.equal(url.hostname,'rutube.ru');assert.equal(init.method,'GET');assert.equal(init.headers.Authorization,undefined);assert.equal(init.body,undefined);
  if(options.notFound)return new Response('',{status:404});
  if(url.pathname===`/api/video/${videoId}/`)return Response.json({id:videoId,author:{id:options.wrongOwner?123:59945486},description:options.wrongCaption?'not the saved caption':caption,duration:options.short?2:13,is_deleted:!!options.processing,is_hidden:false,action_reason:options.processing?{name:'error_upload_video'}:{}});
  assert.equal(url.pathname,`/api/play/options/${videoId}/`);return Response.json({video_id:videoId,author:{id:options.wrongPlaybackOwner?123:59945486},duration:options.shortPlayback?1000:12843,is_hidden:false,has_video:true,acl_access:{allowed:!options.aclPending},video_balancer:options.noStreams?{}:{m3u8:'https://streaming.rutube.ru/synthetic-only'}});
 };
 return {db,env,prior,paths,fetchImpl,run:()=>reconcileDieterRutubeStatus(env,args,{fetchImpl})};
}
test('processing accepted ID stays pending, then anonymous public playback appends one proof',async t=>{
 const options={processing:true},f=fixture(t,options);assert.deepEqual(await f.run(),{status:'pending',code:'rutube_processing_or_moderation',videoId});assert.equal(f.paths.length,1);
 options.processing=false;const r=await f.run();assert.equal(r.status,'verified');assert.match(r.proof.evidence,/playback 12.843s vs original 12.733s/);
 const proofs=JSON.parse(f.db.prepare('SELECT publications FROM ugc_reel_jobs').get().publications);assert.deepEqual(proofs[0],f.prior[0]);assert.equal(proofs[1].url,`https://rutube.ru/video/${videoId}/`);
 const before=f.paths.length;assert.equal((await f.run()).alreadyPresent,true);assert.equal(f.paths.length,before);
});
for(const option of ['wrongOwner','wrongCaption','wrongPlaybackOwner','short','shortPlayback'])test(option+' cannot become verified or cause an upload',async t=>{
 const f=fixture(t,{[option]:true});assert.equal((await f.run()).status,'blocked');assert.equal(JSON.parse(f.db.prepare('SELECT publications FROM ugc_reel_jobs').get().publications).length,1);
});
for(const option of ['notFound','aclPending','noStreams'])test(option+' remains pending without replacing the known ID',async t=>{
 const f=fixture(t,{[option]:true});assert.equal((await f.run()).status,'pending');assert.equal(JSON.parse(f.db.prepare("SELECT value FROM crm_sync_state WHERE key LIKE 'ugc-rutube-pending:%'").get().value).video_id,videoId);
});
test('another claim cannot read providers or save a proof',async t=>{
 const f=fixture(t);f.db.prepare("UPDATE ugc_reel_jobs SET claim_id='other'").run();assert.equal((await f.run()).code,'rutube_exact_working_claim_required');assert.equal(f.paths.length,0);
});
test('proof CAS conflict is retained for another read, never a new video',async t=>{
 const options={conflict:true},f=fixture(t,options);assert.equal((await f.run()).code,'rutube_proof_cas_conflict_read_again');const gets=f.paths.length;
 options.conflict=false;options.notFound=true;const result=await f.run();assert.equal(result.status,'verified');assert.equal(result.cachedProof,true);assert.equal(f.paths.length,gets);
});
test('missing or caller-controlled pending ID never becomes an arbitrary fetch URL',async t=>{
 const f=fixture(t);f.db.prepare("UPDATE crm_sync_state SET value=? WHERE key LIKE 'ugc-rutube-pending:%'").run(JSON.stringify({video_id:'https://example.invalid/other',source_sha256:sha,duration_seconds:12.733}));assert.equal((await f.run()).code,'rutube_exact_pending_id_and_source_required');assert.equal(f.paths.length,0);
});
test('parent and child executions share three durable poll cycles, never three each',async t=>{
 const f=fixture(t,{processing:true});const parent=()=>f.run(),child=()=>reconcileDieterRutubeStatus({DB:f.env.DB},args,{fetchImpl:f.fetchImpl});
 assert.equal((await parent()).status,'pending');assert.equal((await child()).status,'pending');const last=await parent();assert.equal(last.code,'rutube_poll_budget_exhausted');assert.equal(last.pendingCode,'rutube_processing_or_moderation');
 const result=await child();assert.equal(result.code,'rutube_poll_budget_exhausted');assert.equal(result.pollAttempts,3);assert.equal(f.paths.length,3);
 assert.equal((await parent()).code,'rutube_poll_budget_exhausted');assert.equal(f.paths.length,3);
});
test('overlapping parent/child callers cannot exceed the shared provider budget',async t=>{
 const f=fixture(t,{processing:true});await Promise.all(Array.from({length:10},()=>f.run()));
 for(let i=0;i<4;i++)await reconcileDieterRutubeStatus({DB:f.env.DB},args,{fetchImpl:f.fetchImpl});
 assert.equal(f.paths.length,3);assert.equal((await f.run()).code,'rutube_poll_budget_exhausted');
});
test('third poll public proof is cached before a failed ERP CAS; fourth call uses zero GET',async t=>{
 const options={processing:true},f=fixture(t,options);await f.run();await f.run();options.processing=false;options.conflict=true;
 assert.equal((await f.run()).code,'rutube_proof_cas_conflict_read_again');const gets=f.paths.length;
 options.conflict=false;options.notFound=true;const result=await f.run();assert.equal(result.status,'verified');assert.equal(result.cachedProof,true);assert.equal(f.paths.length,gets);
 const budget=JSON.parse(f.db.prepare("SELECT value FROM crm_sync_state WHERE key LIKE 'ugc-rutube-poll-budget:%'").get().value);assert.equal(budget.attempts,3);
});
test('a new working claim for the same accepted ID uses the cached proof without new polls',async t=>{
 const options={conflict:true},f=fixture(t,options);await f.run();const gets=f.paths.length;options.conflict=false;
 f.db.prepare("UPDATE ugc_reel_jobs SET claim_id='claim-two'").run();
 for(const prefix of ['ugc-rutube-pending','ugc-caption-plan']){const row=f.db.prepare('SELECT value FROM crm_sync_state WHERE key=?').get(prefix+':content:claim');f.db.prepare('INSERT INTO crm_sync_state VALUES(?,?,0)').run(prefix+':content:claim-two',row.value);}
 const result=await reconcileDieterRutubeStatus(f.env,{...args,claimId:'claim-two'},{fetchImpl:f.fetchImpl});assert.equal(result.status,'verified');assert.equal(result.cachedProof,true);assert.equal(f.paths.length,gets);
});
test('a changed caption cannot reuse or overwrite a cached public proof',async t=>{
 const f=fixture(t,{conflict:true});await f.run();const gets=f.paths.length;
 f.db.prepare("UPDATE crm_sync_state SET value=? WHERE key='ugc-caption-plan:content:claim'").run(JSON.stringify({content_id:'content',platforms:{rutube:{caption:'changed caption'}}}));
 assert.equal((await f.run()).code,'rutube_cached_proof_identity_conflict');assert.equal(f.paths.length,gets);
});
