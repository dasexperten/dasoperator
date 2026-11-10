import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {runDieterTikTokApi,ensureDieterTikTokSourceAsset} from './dieter-tiktok.ts';
const bytes=new TextEncoder().encode('synthetic-original-video-bytes');
const sha=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
const asset=`https://org.dasexperten.com/assets/ugc/${sha}/original.mp4`,source='https://www.instagram.com/reel/FixtureSource/';
const caption=`creator_fixture original ${source} #oralcare`,videoId='7706215046463999252',publicUrl=`https://www.tiktok.com/@dasbroadcast/video/${videoId}`;
const args={contentId:'content-one',claimId:'claim-one',sourceSha256:sha,sourceAssetUrl:asset,sourceDurationSeconds:13,sourceAuthor:'creator_fixture',sourceUrl:source,sourceDriveId:'fixture-drive-original'};
function fixture(t,options={}){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec('CREATE TABLE crm_sync_state(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER);CREATE TABLE ugc_reel_jobs(content_id TEXT PRIMARY KEY,status TEXT,claim_id TEXT,required_destinations TEXT,publications TEXT,updated_at TEXT)');
 const prior=[{platform:'instagram',url:'https://www.instagram.com/reel/ExistingFixture/'}];
 db.prepare('INSERT INTO ugc_reel_jobs VALUES(?,?,?,?,?,?)').run(args.contentId,'working',args.claimId,JSON.stringify(['instagram','tiktok']),JSON.stringify(prior),'old');
 const plan={content_id:args.contentId,platforms:{tiktok:{caption}}};
 db.prepare('INSERT INTO crm_sync_state VALUES(?,?,0)').run(`ugc-caption-plan:${args.contentId}:${args.claimId}`,JSON.stringify(plan));
 let posts=0,posted=false,statusReads=0;const requests=[];
 const env={GITHUB_TOKEN:'fixture-github-only',DB:{
  prepare(sql){let values=[];return {
   bind(...v){values=v;return this;},
   async first(){return db.prepare(sql).get(...values)??null;},
   async run(){
    if(options.stopBeforeRequestCAS&&sql.startsWith('UPDATE crm_sync_state')&&JSON.parse(values[0]).state==='publish_requested')db.prepare('INSERT OR IGNORE INTO crm_sync_state VALUES(?,?,0)').run('dieter_cloud_runtime_stop','{}');
    if(options.failRequestCAS&&sql.startsWith('UPDATE crm_sync_state')&&JSON.parse(values[0]).state==='publish_requested')throw Error('synthetic crash before provider intent');
    if(options.proofConflict&&sql.startsWith('UPDATE ugc_reel_jobs SET publications'))return {meta:{changes:0}};
    return {meta:{changes:Number(db.prepare(sql).run(...values).changes)}};
   }
  };}
 }};
 const vault=['TIKTOK_BUSINESS_APP_ID=7706160588917342228','TIKTOK_BUSINESS_USERNAME=dasbroadcast','TIKTOK_BUSINESS_OPEN_ID=fixture-business','TIKTOK_BUSINESS_ACCESS_TOKEN=fixture-token-not-real','TIKTOK_BUSINESS_SCOPE=video.upload,video.publish,video.list','TIKTOK_BUSINESS_ACCESS_TOKEN_EXPIRES_AT=2099-01-01T00:00:00Z'].join('\n');
 const ledger=()=>{const row=db.prepare("SELECT value FROM crm_sync_state WHERE key LIKE 'ugc-tiktok-business:%'").get();return row?JSON.parse(row.value):null};
 const fetchImpl=async(value,init={})=>{
  if(options.cloudRuntime&&init.redirect==='error')throw new TypeError('Workers Request does not implement error redirect mode; synthetic-private-detail');
  const url=new URL(value);requests.push({host:url.hostname,path:url.pathname,method:init.method??'GET'});
  assert.equal(url.searchParams.has('access_token'),false);
  if(url.hostname==='api.github.com'){assert.equal(init.headers.Authorization,'Bearer fixture-github-only');return Response.json({content:btoa(vault)});}
  if(url.hostname==='org.dasexperten.com')return new Response(options.badSource?'wrong':bytes,{headers:{'Content-Type':options.mime??'video/mp4'}});
  assert.equal(url.hostname,'business-api.tiktok.com');assert.equal(init.headers['Access-Token'],'fixture-token-not-real');
  const reply=data=>Response.json({code:0,data});
  if(url.pathname.endsWith('/business/get/'))return reply({username:'dasbroadcast'});
  if(url.pathname.endsWith('/business/video/settings/'))return reply({privacy_level_options:['PUBLIC_TO_EVERYONE'],max_video_post_duration_sec:3600,comment_disabled:false,duet_disabled:true,stitch_disabled:false});
  if(url.pathname.endsWith('/business/video/list/')){
   if(options.cycle)return reply({videos:[],has_more:true,cursor:20});
   if(options.paged&&!url.searchParams.has('cursor'))return reply({videos:[{item_id:'123',caption:'unrelated'}],has_more:true,cursor:20});
   if(options.paged)assert.equal(url.searchParams.get('cursor'),'20');
   return reply({videos:posted?[{item_id:videoId,caption:caption.replace(/ /g,'\n'),share_url:publicUrl,video_duration:options.duration??13.11}]:options.existing?[{item_id:'123',caption:'creator_fixture another source'}]:[],has_more:false,cursor:0});
  }
  if(url.pathname.endsWith('/business/video/publish/')){
   posts++;assert.equal(ledger().state,'publish_requested');const body=JSON.parse(init.body);
   assert.deepEqual(body,{business_id:'fixture-business',video_url:asset,post_info:{caption,is_brand_organic:true,is_branded_content:false,disable_comment:false,disable_duet:true,disable_stitch:false,is_ai_generated:false,upload_to_draft:false,is_ads_only:false}});
   if(options.unknown)throw Error('socket lost with fixture-token-not-real');
   posted=true;return reply({share_id:'v_pub_url~fixture'});
  }
  if(url.pathname.endsWith('/business/publish/status/')){
   statusReads++;assert.equal(ledger().shareId,'v_pub_url~fixture');assert.equal(ledger().state,'accepted');assert.equal(url.searchParams.get('publish_id'),'v_pub_url~fixture');
   return reply(options.pending&&statusReads===1?{status:'PUBLISH_COMPLETE'}:{status:'PUBLISH_COMPLETE',post_ids:[videoId]});
  }
  assert.fail('unexpected transport path');
 };
 return {db,env,fetchImpl,ledger,prior,stats:()=>({posts,statusReads,requests}),run:(mode='publish')=>runDieterTikTokApi(env,args,mode,{fetchImpl})};
}
test('one exact Business POST, accepted ID persisted before readback, prior proofs preserved',async t=>{
 const f=fixture(t,{paged:true});const result=await f.run();assert.equal(result.status,'verified',JSON.stringify(result));assert.equal(f.stats().posts,1);assert.equal(f.ledger().state,'verified');
 const proofs=JSON.parse(f.db.prepare('SELECT publications FROM ugc_reel_jobs').get().publications);assert.deepEqual(proofs[0],f.prior[0]);assert.equal(proofs[1].url,publicUrl);assert.match(proofs[1].evidence,/returned duration 13.11s vs original 13s/);
 assert.equal((await f.run('reconcile')).status,'verified');assert.equal(f.stats().posts,1);
 assert.ok(!JSON.stringify(f.ledger()).includes('fixture-token-not-real'));assert.ok(!JSON.stringify(result).includes('fixture-token-not-real'));
});
test('preflight has no TikTok POST, no ledger, no proof writes',async t=>{
 const f=fixture(t);const r=await f.run('preflight');assert.equal(r.status,'preflight_ready');assert.equal(f.ledger(),null);assert.equal(f.stats().posts,0);assert.deepEqual(JSON.parse(f.db.prepare('SELECT publications FROM ugc_reel_jobs').get().publications),f.prior);
});
test('Cloudflare redirect contract and octet-stream asset hosting support the complete one-post path',async t=>{
 const f=fixture(t,{cloudRuntime:true,mime:'application/octet-stream'});const result=await f.run();assert.equal(result.status,'verified',JSON.stringify(result));assert.equal(f.stats().posts,1);
});
test('an unexpected first-fetch TypeError exposes only the fixed phase and class before any intent',async t=>{
 const f=fixture(t),result=await runDieterTikTokApi(f.env,args,'preflight',{fetchImpl:async()=>{throw new TypeError('synthetic-private-value-not-for-output');}});
 assert.equal(result.code,'tiktok_transport_failed_closed');assert.deepEqual(result.diagnostic,{phase:'grant_read',error_class:'type_error'});assert.equal(f.ledger(),null);assert.equal(f.stats().posts,0);assert.ok(!JSON.stringify(result).includes('synthetic-private-value'));
});
test('a manual vault redirect is rejected without forwarding its credential',async t=>{
 const f=fixture(t);let requests=0;
 const result=await runDieterTikTokApi(f.env,args,'preflight',{fetchImpl:async(_url,init)=>{requests++;assert.equal(init.redirect,'manual');return new Response('',{status:302,headers:{Location:'https://example.invalid/never-follow'}});}});
 assert.equal(result.code,'tiktok_vault_unavailable');assert.equal(result.diagnostic.phase,'grant_read');assert.equal(requests,1);assert.equal(f.ledger(),null);
});
test('HTML or a wrong octet-stream body cannot pass the exact original SHA check',async t=>{
 for(const options of [{mime:'text/html'},{mime:'application/octet-stream',badSource:true}]){
  const f=fixture(t,options),result=await f.run('preflight');assert.equal(result.status,'blocked');assert.equal(f.stats().posts,0);assert.equal(f.ledger(),null);
 }
});
test('uncertain POST is durably blocked from a second send across modes',async t=>{
 const f=fixture(t,{unknown:true});assert.equal((await f.run()).status,'uncertain');assert.equal(f.ledger().state,'uncertain');assert.equal((await f.run()).status,'uncertain');assert.equal((await f.run('reconcile')).status,'uncertain');assert.equal(f.stats().posts,1);
});
test('PUBLISH_COMPLETE without IDs resumes through saved share ID with GET only',async t=>{
 const f=fixture(t,{pending:true});assert.equal((await f.run()).status,'pending');assert.equal(f.ledger().shareId,'v_pub_url~fixture');assert.equal((await f.run('reconcile')).status,'verified');assert.equal(f.stats().posts,1);assert.equal(f.stats().statusReads,2);
});
test('concurrent publishers cannot cross the one-POST CAS twice',async t=>{
 const f=fixture(t);const results=await Promise.all([f.run(),f.run()]);assert.equal(f.stats().posts,1);assert.ok(results.some(r=>r.status==='verified'));
});
test('saved caption plan is a mechanical pre-send gate and immutable after intent',async t=>{
 const f=fixture(t,{pending:true});f.db.prepare("DELETE FROM crm_sync_state WHERE key LIKE 'ugc-caption-plan:%'").run();assert.equal((await f.run()).code,'tiktok_saved_caption_plan_required');assert.equal(f.stats().posts,0);assert.equal(f.ledger(),null);
});
test('changed caption cannot repurpose an existing source ledger',async t=>{
 const f=fixture(t,{pending:true});await f.run();const row=f.db.prepare("SELECT key,value FROM crm_sync_state WHERE key LIKE 'ugc-caption-plan:%'").get();const plan=JSON.parse(row.value);plan.platforms.tiktok.caption+=' changed';f.db.prepare('UPDATE crm_sync_state SET value=? WHERE key=?').run(JSON.stringify(plan),row.key);
 assert.equal((await f.run()).code,'tiktok_immutable_source_or_caption_conflict');assert.equal(f.stats().posts,1);
});
for(const kind of ['badSource','cycle','existing'])test(kind+' cannot create a publication intent',async t=>{
 const f=fixture(t,{[kind]:true});assert.equal((await f.run()).status,'blocked');assert.equal(f.stats().posts,0);assert.equal(f.ledger(),null);
});
test('expired grant never causes a new POST and retains an accepted ledger for future GET recovery',async t=>{
 const f=fixture(t,{pending:true});await f.run();const r=await runDieterTikTokApi(f.env,args,'reconcile',{fetchImpl:f.fetchImpl,now:()=>Date.parse('2100-01-01')});assert.equal(r.code,'tiktok_grant_expired');assert.equal(f.ledger().shareId,'v_pub_url~fixture');assert.equal(f.stats().posts,1);
});
test('a crash after reservation but before intent can safely resume one first POST',async t=>{
 const options={failRequestCAS:true},f=fixture(t,options);assert.equal((await f.run()).status,'blocked');assert.equal(f.ledger().state,'reserved');assert.equal(f.stats().posts,0);
 options.failRequestCAS=false;assert.equal((await f.run()).status,'verified');assert.equal(f.stats().posts,1);
});
test('proof CAS failure preserves verified provider receipt and resumes without republishing',async t=>{
 const options={proofConflict:true},f=fixture(t,options);assert.equal((await f.run()).code,'tiktok_proof_cas_conflict_read_only_resume');assert.equal(f.ledger().state,'verified');assert.equal(f.stats().posts,1);
 options.proofConflict=false;assert.equal((await f.run('reconcile')).status,'verified');assert.equal(f.stats().posts,1);
});
for(const duration of [0,1,16,'13'])test('invalid/truncated provider duration '+duration+' cannot become verified or cause resending',async t=>{
 const options={duration},f=fixture(t,options);assert.equal((await f.run()).code,'tiktok_original_duration_readback_mismatch');assert.equal(f.ledger().state,'accepted');assert.equal(f.ledger().shareId,'v_pub_url~fixture');assert.equal(f.stats().posts,1);
 options.duration=13.11;assert.equal((await f.run('reconcile')).status,'verified');assert.equal(f.stats().posts,1);
});
test('canonical source hosting uses exact Drive bytes and org/assets R2 mapping, then public SHA readback',async()=>{
 let hosted=false,puts=0;const env={DIETER_PRIVATE_FILES:JSON.stringify({'google-drive-api.json':{client_id:'fixture-client',client_secret:'fixture-secret',refresh_token:'fixture-refresh'}}),ORG_ASSETS:{async put(key,value,options){puts++;assert.equal(key,`org/assets/ugc/${sha}/original.mp4`);assert.equal(options.httpMetadata.contentType,'video/mp4');assert.deepEqual(new Uint8Array(value),bytes);hosted=true;}}};
 const fetcher=async(u,init={})=>{
  assert.equal(init.redirect,'manual');
  if(u===asset)return hosted?new Response(bytes,{headers:{'Content-Type':'application/octet-stream'}}):new Response('',{status:404});
  if(u==='https://oauth2.googleapis.com/token'){assert.equal(init.method,'POST');return Response.json({access_token:'fixture-drive-token'});}
  assert.equal(new URL(u).searchParams.get('alt'),'media');assert.equal(init.headers.Authorization,'Bearer fixture-drive-token');return new Response(bytes);
 };
 assert.equal((await ensureDieterTikTokSourceAsset(env,args,fetcher)).sourceHosted,true);assert.equal(puts,1);
 assert.equal((await ensureDieterTikTokSourceAsset(env,args,fetcher)).sourceHosted,false);assert.equal(puts,1);
});

test('global stop appearing at the final publish-request CAS prevents the provider POST',async t=>{
 const f=fixture(t,{stopBeforeRequestCAS:true});const result=await f.run();assert.equal(f.stats().posts,0);assert.equal(f.ledger().state,'reserved');assert.equal(result.status,'pending');
});
