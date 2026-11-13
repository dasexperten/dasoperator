import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const temp = mkdtempSync(join(tmpdir(),'ugc-reel-test-'));
const root = new URL('../../../', import.meta.url);
await build({ entryPoints: [new URL('../routes/internal-ugc.ts', import.meta.url).pathname], bundle:true, platform:'node', format:'esm', outfile:join(temp,'route.mjs'),logLevel:'silent' });
await build({ entryPoints: [new URL('./ugc-reel-store.ts', import.meta.url).pathname], bundle:true, platform:'node', format:'esm', outfile:join(temp,'store.mjs'),logLevel:'silent' });
await build({ entryPoints: [new URL('../routes/ugc.ts', import.meta.url).pathname], bundle:true, platform:'node', format:'esm', outfile:join(temp,'ugc.mjs'),logLevel:'silent' });
const ownerRoute = (await import(pathToFileURL(join(temp,'ugc.mjs')).href)).default;
const route = (await import(pathToFileURL(join(temp,'route.mjs')).href)).default;
const { tickDiterAlarm, tickDiterUgcAlarm, diterWindow, acceptLegacyReel } = await import(pathToFileURL(join(temp,'store.mjs')).href);
const sqlite = new DatabaseSync(':memory:');
sqlite.exec('CREATE TABLE crm_sync_state(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER)');
sqlite.exec(`CREATE TABLE ugc_content(id TEXT PRIMARY KEY,creator_platform_id TEXT,content_url TEXT,content_type TEXT); CREATE TABLE ugc_creator_platforms(id TEXT PRIMARY KEY,handle TEXT,platform TEXT);`);
sqlite.exec(readFileSync(new URL('db/migrations/0157_ugc_reel_jobs.sql',root),'utf8'));
sqlite.exec(readFileSync(new URL('db/migrations/0159_ugc_reel_alarm.sql',root),'utf8'));
sqlite.exec(`INSERT INTO ugc_content VALUES('reel1','profile','https://instagram.com/reel/SOURCE/','video'); INSERT INTO ugc_creator_platforms VALUES('profile','real_author','instagram');`);
const DB = { async batch(statements){sqlite.exec('BEGIN');try {const out=[];for(const s of statements)out.push(await s.run());sqlite.exec('COMMIT');return out;}catch(e){sqlite.exec('ROLLBACK');throw e;}}, prepare(sql) { return { values:[], bind(...values){this.values=values;return this;}, async first(){return sqlite.prepare(sql).get(...this.values) ?? null;}, async all(){return {results:sqlite.prepare(sql).all(...this.values)};}, async run(){const result=sqlite.prepare(sql).run(...this.values);return {meta:{changes:Number(result.changes)}};} }; } };
const env = {DB,EMAILER_SERVICE_SECRET:'test-only-service-secret'};
const request = async (path,body,authorized=true) => {
  const headers = {'Content-Type':'application/json',...(authorized?{'X-Emailer-Service-Secret':env.EMAILER_SERVICE_SECRET}:{})};
  return route.request(`https://erp.test${path}`,{method:body===undefined?'GET':'POST',headers,...(body===undefined?{}:{body:JSON.stringify(body)})},env,{waitUntil(){},passThroughOnException(){}});
};
sqlite.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,role TEXT,active INTEGER,permissions TEXT);CREATE TABLE sessions(token TEXT PRIMARY KEY,user_id TEXT,expires_at INTEGER);
INSERT INTO users VALUES('owner','Owner','admin',1,'{}');INSERT INTO users VALUES('staff','Staff','manager',1,'{"/ugc":"rw"}');`);
for(const [token,user] of [['owner-session-token','owner'],['staff-session-token','staff']]) sqlite.prepare('INSERT INTO sessions VALUES(?,?,?)').run(token,user,Date.now()+60000);
const insert = () => sqlite.exec(`INSERT OR IGNORE INTO ugc_reel_jobs(content_id,requested_by,requested_at,updated_at) VALUES('reel1','owner','2026-11-07T00:00:00.000Z','2026-11-07T00:00:00.000Z')`);
const row = () => sqlite.prepare('SELECT * FROM ugc_reel_jobs').get();
const monday = Date.parse('2026-11-09T09:00:00Z'); // 12:00 Moscow
const resetAlarm = () => sqlite.exec("UPDATE ugc_reel_alarm SET consumer_id=NULL,heartbeat_at=NULL,ready=0,last_started_at=NULL,pending_content_id=NULL");
const ready = (at=monday) => sqlite.prepare("UPDATE ugc_reel_alarm SET consumer_id='mac-dieter-test',heartbeat_at=?,ready=1").run(at);
test('consumer registration requires capability, excludes competing identity and preserves existing published rows',async()=>{
  resetAlarm();
  const pulse={consumer_id:'mac-dieter-test',ready:true,capabilities:['diter-ugc-round']};
  assert.equal((await request('/alarm/pulse',pulse,false)).status,401);
  assert.equal((await request('/alarm/pulse',pulse)).status,200);
  assert.equal((await request('/alarm/pulse',{...pulse,consumer_id:'mac-dieter-other'})).status,409);
  assert.equal((await request('/alarm/pulse',{...pulse,ready:false})).status,200);
  const status=await(await request('/alarm/status')).json();assert.equal(status.state.ready,0);
  assert.equal(status.alarm,'erp-ugc-diter');
  assert.equal(status.schedule.timezone,'Europe/Moscow');
  assert.deepEqual(status.schedule.weekends,['10:00','11:30','13:00','14:30','16:00','17:30','19:00','20:30','22:00']);
  const legacy=await(await request('/reel-alarm')).json();
  assert.equal(legacy.name,'diter-ugc-alarm');assert.equal(legacy.alarm,'erp-ugc-diter');
  const canonical=await(await route.request('https://erp.test/reel-alarm',{headers:{'X-Emailer-Service-Secret':env.EMAILER_SERVICE_SECRET,'X-UGC-Alarm-Name':'erp-ugc-diter'}},env)).json();
  assert.equal(canonical.name,'erp-ugc-diter');
  resetAlarm();
});
test('fixed slots ignore intervening minutes and accept each trigger once under overlapping cron ticks',async()=>{
  sqlite.exec("DELETE FROM crm_sync_state WHERE key='slot:erp-ugc-diter'");
  const start=new Date('2026-11-09T09:00:00Z');
  const results=await Promise.all([tickDiterUgcAlarm(env,start),tickDiterUgcAlarm(env,start)]);
  assert.equal(results.filter(r=>r.note!=='not_due').length,1);
  for(const delta of [60000,7*60000,15*60000,29*60000]) assert.equal((await tickDiterUgcAlarm(env,new Date(+start+delta))).note,'not_due');
  assert.notEqual((await tickDiterUgcAlarm(env,new Date(+start+90*60000))).note,'not_due');
  assert.equal((await tickDiterUgcAlarm(env,new Date(+start+90*60000+40000))).note,'not_due');
  sqlite.exec("DELETE FROM crm_sync_state WHERE key='slot:erp-ugc-diter'");
});
test('trigger allows bounded preflight only at the new Moscow cadence',()=>{
  const check=(s,expected)=>assert.equal(diterWindow(Date.parse(s)),expected,s);
  check('2026-11-07T06:59:59Z',false);check('2026-11-07T07:00:00Z',true);
  check('2026-11-07T07:02:59Z',true);check('2026-11-07T07:03:00Z',false);
  check('2026-11-09T06:00:00Z',true);check('2026-11-09T09:00:00Z',true);
  check('2026-11-09T09:15:00Z',false);check('2026-11-09T19:30:00Z',true);
});
test('alarm stays red without live consumer or outside windows; atomic one-job acceptance then exact assignment',async()=>{
  insert();resetAlarm();
  assert.equal((await request('/alarm/status',undefined,false)).status,401);
  assert.equal((await request('/alarm/pulse',{consumer_id:'mac-dieter-test',ready:true,capabilities:[]})).status,422);
  assert.equal((await tickDiterAlarm(env,monday)).note,'consumer_missing');assert.equal(row().status,'queued');
  ready(Date.parse('2026-11-07T06:59:00Z'));
  assert.equal((await tickDiterAlarm(env,Date.parse('2026-11-07T06:59:00Z'))).note,'outside_window');assert.equal(row().status,'queued');
  ready(monday-90001);assert.equal((await tickDiterAlarm(env,monday)).note,'consumer_missing');
  ready();
  sqlite.exec("INSERT INTO ugc_content VALUES('reel2','profile','https://instagram.com/reel/SECOND/','video');INSERT INTO ugc_reel_jobs(content_id,requested_by,requested_at,updated_at) VALUES('reel2','owner','2026-11-07T01:00:00Z','2026-11-07T01:00:00Z')");
  assert.equal((await tickDiterAlarm(env,monday)).accepted,true);
  assert.equal((await tickDiterAlarm(env,monday)).note,'working_job_exists');
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM ugc_reel_jobs WHERE status='working'").get().n,1);
  assert.equal((await request('/reel-jobs/reel2/claim',{})).status,409);
  assert.equal((await(await request('/alarm/assignment?consumer_id=other')).json()).assignment,null);
  const assignment=(await(await request('/alarm/assignment?consumer_id=mac-dieter-test')).json()).assignment;
  assert.equal(assignment.content_id,'reel1');assert.equal(assignment.status,'working');assert.ok(assignment.claim_id);
  assert.match(assignment.task,/РОВНО ОДИН/);assert.doesNotMatch(assignment.task,/\/claim /);
  assert.equal((await request('/alarm/ack',{consumer_id:'other',content_id:'reel1',claim_id:assignment.claim_id})).status,409);
  const ack={consumer_id:'mac-dieter-test',content_id:'reel1',claim_id:assignment.claim_id};
  assert.equal((await request('/alarm/ack',ack)).status,200);assert.equal((await request('/alarm/ack',ack)).status,200);
  const jobs=await(await request('/reel-jobs')).json();assert.equal(jobs.jobs[0].claim_id,undefined);
  // A dead executor never silently requeues/starts another job.
  assert.equal((await tickDiterAlarm(env,monday+90*60000)).note,'working_job_exists');
});
test('green requires every persisted destination; existing verified posts count, no reupload required',async()=>{
  const job=sqlite.prepare("SELECT * FROM ugc_reel_jobs WHERE content_id='reel1'").get();
  sqlite.prepare("UPDATE ugc_reel_jobs SET required_destinations=? WHERE content_id='reel1'").run(JSON.stringify(['instagram','threads','vk','youtube','tiktok']));
  const proof={platform:'instagram',url:'https://instagram.com/reel/NEWPOST/',account:'dasexperten',verified:true,verified_at:'2026-11-06T00:00:00Z',evidence:'Existing public original checked with author credit'};
  assert.equal((await request('/reel-jobs/reel1/complete',{claim_id:job.claim_id,publications:[]})).status,422);
  let result=await request('/reel-jobs/reel1/complete',{claim_id:job.claim_id,publications:[proof]});
  assert.equal(result.status,422);assert.equal((await result.json()).missing.length,4);
  const proofs=[proof,{...proof,platform:'threads',url:'https://threads.com/@dasexperten/post/NEWPOST'}, {...proof,platform:'vk',url:'https://vk.ru/clip-123_456'}, {...proof,platform:'youtube',url:'https://youtu.be/AbC123def_0'}, {...proof,platform:'tiktok',account:'dasbroadcast',url:'https://tiktok.com/@dasbroadcast/video/123456789'}];
  assert.equal((await request('/reel-jobs/reel1/complete',{claim_id:'wrong',publications:proofs})).status,409);
  assert.equal((await request('/reel-jobs/reel1/progress',{claim_id:'wrong',publications:[proof]})).status,409);
  assert.equal((await request('/reel-jobs/reel1/progress',{claim_id:job.claim_id,publications:[proof]})).status,200);
  assert.equal(sqlite.prepare("SELECT status FROM ugc_reel_jobs WHERE content_id='reel1'").get().status,'working');
  assert.equal((await request('/reel-jobs/reel1/complete',{claim_id:job.claim_id,publications:proofs.slice(1)})).status,200);
  assert.equal(sqlite.prepare("SELECT status FROM ugc_reel_jobs WHERE content_id='reel1'").get().status,'published');
});
test('legacy wire envelope already carries real publication instructions, not check-only text',async()=>{
 const RealDate=globalThis.Date;
 try {
  globalThis.Date=class extends RealDate { constructor(...args){super(...(args.length?args:[monday]));} static now(){return monday;} };
  sqlite.exec("UPDATE ugc_reel_jobs SET status='queued',claim_id=NULL,attempts=0,started_at=NULL;DELETE FROM ugc_reel_jobs WHERE content_id='reel2'");resetAlarm();
  await tickDiterAlarm(env,monday);
  const envelope=await(await request('/reel-alarm')).json();
  assert.equal(envelope.ready,true);assert.equal(envelope.job.content_id,'reel1');
  assert.match(envelope.job.task,/РОВНО ОДИН/);assert.doesNotMatch(envelope.job.task,/Preflight only/);
  assert.equal(row().status,'queued','reading the envelope never claims or starts work');
 } finally { globalThis.Date=RealDate; }
});
test('legacy PC preflight accepts only the single fresh alarmed id through the same alarm',async()=>{
  sqlite.exec("UPDATE ugc_reel_jobs SET status='queued',claim_id=NULL,attempts=0,started_at=NULL;DELETE FROM ugc_reel_jobs WHERE content_id='reel2'");resetAlarm();
  assert.equal((await tickDiterAlarm(env,monday)).note,'consumer_missing');
  assert.equal(await acceptLegacyReel(env,'wrong-post','https://erp.test',monday),null);
  assert.equal(await acceptLegacyReel(env,'reel1','https://erp.test',monday+180000),null,'stale signal never claims');
  const assignment=await acceptLegacyReel(env,'reel1','https://erp.test',monday);
  assert.equal(assignment.content_id,'reel1');assert.equal(row().status,'working');assert.ok(row().acknowledged_at);
  assert.equal(await acceptLegacyReel(env,'reel1','https://erp.test',monday),null,'repeated acceptance never starts twice');
  sqlite.prepare("UPDATE ugc_reel_jobs SET status='published' WHERE content_id='reel1'").run();
  sqlite.exec("INSERT INTO ugc_reel_jobs(content_id,requested_by,requested_at,updated_at) VALUES('reel2','owner','2026-11-07T01:00:00Z','2026-11-07T01:00:00Z')");
});
test('15-minute start spacing and release attempt limit survive retries',async()=>{
  sqlite.exec("DELETE FROM ugc_reel_jobs WHERE content_id='reel1'");
  ready(monday+60000);assert.equal((await tickDiterAlarm(env,monday+60000)).note,'cooldown');
  for(let i=0;i<3;i++) {
    const now=i<2 ? monday+(i+1)*90*60000 : monday+3*90*60000;ready(now);
    assert.equal((await tickDiterAlarm(env,now)).accepted,true);
    const job=sqlite.prepare("SELECT * FROM ugc_reel_jobs WHERE content_id='reel2'").get();
    assert.equal((await request('/reel-jobs/reel2/release',{claim_id:job.claim_id,error:'No authenticated upload access'})).status,200);
  }
  const after=monday+4*90*60000;ready(after);assert.equal((await tickDiterAlarm(env,after)).note,'empty');
  sqlite.exec('DELETE FROM ugc_reel_jobs');
});
test('three failures quarantine a red reel without losing proofs or stopping the next job',async()=>{
  sqlite.exec('DELETE FROM ugc_reel_jobs');resetAlarm();insert();
  const saved='[{"platform":"instagram","url":"https://instagram.com/reel/KEEPTHEPROOF/"}]';
  sqlite.prepare("UPDATE ugc_reel_jobs SET status='working',claim_id='exact-block-claim',consumer_id='mac-dieter-test',acknowledged_at='ack',attempts=1,publications=? WHERE content_id='reel1'").run(saved);
  const body={claim_id:'exact-block-claim',error:'Three verified failed recovery attempts; publication state retained',failed_attempts:3};
  assert.equal((await request('/reel-jobs/reel1/block',body,false)).status,401);
  for(const failed_attempts of [undefined,0,1,2,4,'3']) assert.equal((await request('/reel-jobs/reel1/block',{...body,failed_attempts})).status,422);
  assert.equal((await request('/reel-jobs/reel1/block',{...body,claim_id:'wrong'})).status,409);
  assert.equal(row().status,'working');
  assert.equal((await request('/reel-jobs/reel1/block',body)).status,200);
  assert.equal(row().status,'queued');assert.equal(row().attempts,3);
  assert.equal(row().publications,saved);assert.equal(row().claim_id,null);assert.equal(row().consumer_id,null);
  assert.equal((await request('/reel-jobs/reel1/block',body)).status,409);
  assert.equal((await request('/reel-jobs/reel1/release',{claim_id:body.claim_id,error:'late callback'})).status,409);
  sqlite.exec("INSERT INTO ugc_reel_jobs(content_id,requested_by,requested_at,updated_at) VALUES('reel2','owner','2026-11-07T01:00:00Z','2026-11-07T01:00:00Z')");
  ready();assert.equal((await tickDiterAlarm(env,monday)).accepted,true);
  assert.equal(sqlite.prepare("SELECT status FROM ugc_reel_jobs WHERE content_id='reel2'").get().status,'working');
  assert.equal(sqlite.prepare("SELECT attempts FROM ugc_reel_jobs WHERE content_id='reel1'").get().attempts,3);
  sqlite.exec('DELETE FROM ugc_reel_jobs');resetAlarm();
});
test('real Owner endpoint authorizes selection and persists one queued job without fake /adhoc wake for repeated clicks',async()=>{
  sqlite.exec('DELETE FROM ugc_reel_jobs');
  const pending=[];const ctx={waitUntil(p){pending.push(p);},passThroughOnException(){}};
  const calls=[];const bound={...env,SEAT_DIETER_VFX:{async fetch(url,init){calls.push({url,init});return Response.json({ok:true});}}};
  const post=(token)=>ownerRoute.request('https://erp.test/content/reel1/reel-job',{method:'POST',headers:{Authorization:`Bearer ${token}`}},bound,ctx);
  assert.equal((await post('invalid')).status,401);
  assert.equal((await post('staff-session-token')).status,403);
  const first=await post('owner-session-token');assert.equal(first.status,200);assert.equal((await first.json()).result.created,true);
  const again=await post('owner-session-token');assert.equal((await again.json()).result.created,false);
  await Promise.all(pending);
  assert.equal(row().status,'queued');assert.equal(row().requested_by,'owner');assert.equal(calls.length,0);
  assert.deepEqual(JSON.parse(row().required_destinations),['instagram','threads','youtube','facebook','vk','rutube','tiktok']);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM ugc_reel_jobs').get().n,1);
});
test('later verified platform URLs append idempotently without changing original published status/date or proofs',async()=>{
  sqlite.exec('DELETE FROM ugc_reel_jobs');insert();
  const original={platform:'instagram',url:'https://www.instagram.com/reel/FIRSTPOST/',account:'dasexperten',verified:true,verified_at:new Date().toISOString(),evidence:'Original checked Instagram post'};
  sqlite.prepare(`UPDATE ugc_reel_jobs SET status='published',started_at='2026-11-06T00:00:00.000Z',published_at='2026-11-07T00:10:00.000Z',publications=?`).run(JSON.stringify([original]));
  const later={...original,platform:'youtube',url:'https://youtu.be/AbC123def_0',account:'channel',evidence:'Opened and checked uploaded full video'};
  assert.equal((await request('/reel-jobs/reel1/publications',{publications:[later]},false)).status,401);
  let res=await request('/reel-jobs/reel1/publications',{publications:[later]});assert.equal(res.status,200);assert.equal((await res.json()).added,1);
  assert.equal(row().status,'published');assert.equal(row().published_at,'2026-11-07T00:10:00.000Z');assert.deepEqual(JSON.parse(row().publications)[0],original);
  res=await request('/reel-jobs/reel1/publications',{publications:[{...later,url:'https://www.youtube.com/watch?v=AbC123def_0'}]});assert.equal((await res.json()).added,0);
  assert.equal(JSON.parse(row().publications).length,2);
  assert.equal((await request('/reel-jobs/reel1/publications',{publications:[{...later,verified:false}]})).status,422);
  sqlite.exec(`UPDATE ugc_reel_jobs SET status='queued'`);
  assert.equal((await request('/reel-jobs/reel1/publications',{publications:[later]})).status,409);
});
test.after(()=>{sqlite.close();rmSync(temp,{recursive:true,force:true});});

test('saved TikTok requirements cannot reconcile green until TikTok proof exists',async()=>{
 const id='scope-reconcile';sqlite.prepare("INSERT INTO ugc_content VALUES(?,?,?,?)").run(id,'profile','https://instagram.com/reel/SCOPEORIGINAL/','video');
 const stamp=new Date().toISOString();const source=['instagram','threads','vk','youtube','tiktok'];
 const base={account:'dasexperten',verified:true,verified_at:stamp,evidence:'Verified exact original and official account'};
 const proofs=[{...base,platform:'instagram',url:'https://instagram.com/reel/SCOPENEW/'},{...base,platform:'threads',url:'https://threads.com/@dasexperten/post/SCOPENEW'},{...base,platform:'youtube',url:'https://youtube.com/watch?v=AbC123def_0'},{...base,platform:'vk',url:'https://vk.ru/video-123_456'}];
 sqlite.prepare("INSERT INTO ugc_reel_jobs(content_id,requested_by,requested_at,updated_at,required_destinations,publications)VALUES(?,?,?,?,?,?)").run(id,'owner',stamp,stamp,JSON.stringify(source),JSON.stringify(proofs));
 const get=()=>sqlite.prepare('SELECT * FROM ugc_reel_jobs WHERE content_id=?').get(id);const before=get();
 assert.equal((await request('/reel-jobs/'+id+'/reconcile-scope',{scope_version:'wrong'})).status,422);
 let res=await request('/reel-jobs/'+id+'/reconcile-scope',{scope_version:'ugc-select-seven-api-pending-wibes-ozon-2026-11-10'});assert.equal(res.status,422);assert.deepEqual((await res.json()).missing,['tiktok']);
 proofs.push({...base,platform:'tiktok',account:'dasbroadcast',url:'https://tiktok.com/@dasbroadcast/video/123456789'});sqlite.prepare('UPDATE ugc_reel_jobs SET publications=? WHERE content_id=?').run(JSON.stringify(proofs),id);
 res=await request('/reel-jobs/'+id+'/reconcile-scope',{scope_version:'ugc-select-seven-api-pending-wibes-ozon-2026-11-10'});assert.equal(res.status,200);let body=await res.json();
 assert.deepEqual(body.destination_scope.active,source);assert.deepEqual(body.destination_scope.deferred,[]);assert.equal(get().required_destinations,before.required_destinations);assert.equal(get().publications,JSON.stringify(proofs));assert.equal(get().claim_id,null);assert.equal(get().status,'published');
 const audit=JSON.parse(sqlite.prepare('SELECT value FROM crm_sync_state WHERE key=?').get('ugc-reel-scope:'+id).value);assert.equal(audit.completion,'attended_existing_proofs');assert.equal(audit.original_required_destinations.length,5);
});
test('historical Rutube becomes active but needs its own saved proof before green',async()=>{
 const id='scope-paused';sqlite.prepare("INSERT INTO ugc_content VALUES(?,?,?,?)").run(id,'profile','https://instagram.com/reel/PAUSEDORIGINAL/','video');const stamp=new Date().toISOString();
 sqlite.prepare("INSERT INTO ugc_reel_jobs(content_id,requested_by,requested_at,updated_at,required_destinations)VALUES(?,?,?,?,?)").run(id,'owner',stamp,stamp,'["tiktok","rutube"]');
 assert.equal((await request('/reel-jobs/'+id+'/reconcile-scope',{scope_version:'ugc-select-seven-api-pending-wibes-ozon-2026-11-10'})).status,422);
 assert.equal(sqlite.prepare('SELECT status FROM ugc_reel_jobs WHERE content_id=?').get(id).status,'queued');
 const proof={platform:'rutube',url:'https://rutube.ru/video/0123456789abcdef0123456789abcdef/',account:'59945486',verified:true,verified_at:stamp,evidence:'Official company channel public playable video checked'};
 sqlite.prepare('UPDATE ugc_reel_jobs SET publications=? WHERE content_id=?').run(JSON.stringify([proof]),id);
 const withoutTikTok=await request('/reel-jobs/'+id+'/reconcile-scope',{scope_version:'ugc-select-seven-api-pending-wibes-ozon-2026-11-10'});assert.equal(withoutTikTok.status,422);assert.deepEqual((await withoutTikTok.json()).missing,['tiktok']);
 sqlite.prepare('UPDATE ugc_reel_jobs SET publications=? WHERE content_id=?').run(JSON.stringify([proof,{...proof,platform:'tiktok',account:'dasbroadcast',url:'https://tiktok.com/@dasbroadcast/video/1234567890'}]),id);
 const result=await request('/reel-jobs/'+id+'/reconcile-scope',{scope_version:'ugc-select-seven-api-pending-wibes-ozon-2026-11-10'});assert.equal(result.status,200);
 const body=await result.json();assert.deepEqual(body.destination_scope.active,['tiktok','rutube']);assert.deepEqual(body.destination_scope.deferred,[]);
 assert.equal(sqlite.prepare('SELECT required_destinations FROM ugc_reel_jobs WHERE content_id=?').get(id).required_destinations,'["tiktok","rutube"]');
});

test('caption plan is claim-bound immutable evidence, not a publication proof or a missing-pool approval gate',async()=>{
 const id='caption-plan-source',stamp=new Date().toISOString(),claim='caption-only-test-claim';
 sqlite.prepare('INSERT INTO ugc_content VALUES(?,?,?,?)').run(id,'profile','https://youtube.com/watch?v=source123','video');
 sqlite.prepare("INSERT INTO ugc_reel_jobs(content_id,requested_by,requested_at,updated_at,status,claim_id,required_destinations)VALUES(?,?,?,?,?,?,?)").run(id,'owner',stamp,stamp,'working',claim,'["facebook"]');
 const get=()=>sqlite.prepare('SELECT * FROM ugc_reel_jobs WHERE content_id=?').get(id);
 const item={caption:'Verified brand Product. Author credit. #Context',hashtags:['Context'],native_topic_applied:false,selection_evidence:'Exact-source product and observed context check',product_keyword_provenance:{verified_products:[{brand:'Verified brand',canonical_name:'Product'}],keyword_status:'missing_pool',selected_keyword_phrases:[],keyword_pool_id:null}};
 const plan={content_id:id,policy_id:'reviewed-caption-policy',platforms:{facebook:item}},body={claim_id:claim,plan};
 assert.equal((await request('/reel-jobs/'+id+'/caption-plan',undefined,false)).status,401);
 assert.equal((await request('/reel-jobs/'+id+'/caption-plan')).status,404);
 assert.equal((await request('/reel-jobs/'+id+'/caption-plan',body,false)).status,401);
 assert.equal((await request('/reel-jobs/'+id+'/caption-plan',{...body,claim_id:'other'})).status,409);
 assert.equal((await request('/reel-jobs/'+id+'/caption-plan',{...body,plan:{...plan,content_id:'other'}})).status,422);
 assert.equal((await request('/reel-jobs/'+id+'/caption-plan',{...body,plan:{...plan,platforms:{tiktok:item}}})).status,422);
 assert.equal((await request('/reel-jobs/'+id+'/caption-plan',body)).status,422);
 sqlite.prepare('INSERT INTO crm_sync_state VALUES(?,?,?)').run('ugc-alexandra-headline:'+id,JSON.stringify({state:'ready',model:'gpt-6-astra',headline:item.caption}),Date.now());
 item.caption+='\nA source-grounded description.';
 assert.equal((await request('/reel-jobs/'+id+'/caption-plan',body)).status,200);
 assert.equal((await(await request('/reel-jobs/'+id+'/caption-plan',body)).json()).caption_plan_saved,true);
 const saved=sqlite.prepare('SELECT value FROM crm_sync_state WHERE key=?').get('ugc-caption-plan:'+id+':'+claim).value;
 const readback=await(await request('/reel-jobs/'+id+'/caption-plan')).json();
 assert.equal(readback.claim_id,claim);assert.equal(readback.caption_plan_saved,true);assert.deepEqual(readback.plan,plan);
 assert.equal((await request('/reel-jobs/'+id+'/caption-plan?claim_id=other')).status,404);
 assert.deepEqual(JSON.parse(saved),plan);assert.equal(get().status,'working');assert.equal(get().publications,'[]');
 const revised={...plan,platforms:{facebook:{...item,caption:'Changed after immutable intent'}}};
 assert.equal((await request('/reel-jobs/'+id+'/caption-plan',{...body,plan:revised})).status,409);
 assert.equal(sqlite.prepare('SELECT value FROM crm_sync_state WHERE key=?').get('ugc-caption-plan:'+id+':'+claim).value,saved);
 sqlite.prepare("UPDATE ugc_reel_jobs SET status='queued' WHERE content_id=?").run(id);
 assert.equal((await request('/reel-jobs/'+id+'/caption-plan',body)).status,409);
 assert.deepEqual((await(await request('/reel-jobs/'+id+'/caption-plan?claim_id='+claim)).json()).plan,plan);
});

test('Owner caption-only fallback saves an unresolved product without inventing a pool; author and original text are mandatory',async()=>{
 const id='caption-fallback',claim='source-caption-claim';
 sqlite.prepare("INSERT INTO ugc_content VALUES(?,?,?,?)").run(id,'profile','https://instagram.com/reel/FALLBACK/','video');
 sqlite.prepare("INSERT INTO ugc_reel_jobs(content_id,requested_by,requested_at,updated_at,status,claim_id,required_destinations) VALUES(?,?,?,?,?,?,?)").run(id,'owner','now','now','working',claim,'["threads"]');
 const provenance={verified_products:[],keyword_status:'source_caption_only',keyword_pool_id:null,selected_keyword_phrases:[],product_resolution:{status:'unresolved',author:'source_author',source_caption:'My original morning routine',evidence:'ERP and caption contain no clear product identity'}};
 const item={caption:'source_author: a fresh morning routine. #MorningRoutine',hashtags:['MorningRoutine'],native_topic_applied:false,selection_evidence:'Owner source-caption fallback',product_keyword_provenance:provenance};
 const plan={content_id:id,policy_id:'diter-source-caption-2026-11-09-v3',platforms:{threads:item}};
 for(const field of ['author','source_caption','evidence']){
  const bad=structuredClone(plan);bad.platforms.threads.product_keyword_provenance.product_resolution[field]='';
  assert.equal((await request('/reel-jobs/'+id+'/caption-plan',{claim_id:claim,plan:bad})).status,422);
 }
 const bad=structuredClone(plan);bad.platforms.threads.caption='No credit';
 assert.equal((await request('/reel-jobs/'+id+'/caption-plan',{claim_id:claim,plan:bad})).status,422);
 sqlite.prepare('INSERT INTO crm_sync_state VALUES(?,?,?)').run('ugc-alexandra-headline:'+id,JSON.stringify({state:'ready',model:'gpt-6-astra',headline:item.caption}),Date.now());
 assert.equal((await request('/reel-jobs/'+id+'/caption-plan',{claim_id:claim,plan})).status,200);
 assert.equal(sqlite.prepare('SELECT status FROM ugc_reel_jobs WHERE content_id=?').get(id).status,'working');
 sqlite.prepare('DELETE FROM ugc_reel_jobs WHERE content_id=?').run(id);
});


test('deferred destinations cannot enter a new publication caption plan',async()=>{
 const id='deferred-api',claim='deferred-api-claim',stamp=new Date().toISOString();
 sqlite.prepare('INSERT INTO ugc_content VALUES(?,?,?,?)').run(id,'profile','https://instagram.com/reel/DEFERREDSOURCE/','video');
 sqlite.prepare("INSERT INTO ugc_reel_jobs(content_id,requested_by,requested_at,updated_at,status,claim_id,required_destinations) VALUES(?,?,?,?,?,?,?)").run(id,'owner',stamp,stamp,'working',claim,JSON.stringify(['threads','wibes','ozon']));
 const provenance={verified_products:[],keyword_status:'source_caption_only',keyword_pool_id:null,selected_keyword_phrases:[],product_resolution:{status:'unresolved',author:'source_author',source_caption:'Original routine',evidence:'No clear SKU in the approved source'}};
 const item={caption:'source_author: original routine. #MorningRoutine',hashtags:['MorningRoutine'],native_topic_applied:false,selection_evidence:'Source-specific caption',product_keyword_provenance:provenance};
 sqlite.prepare('INSERT INTO crm_sync_state VALUES(?,?,?)').run('ugc-alexandra-headline:'+id,JSON.stringify({state:'ready',model:'gpt-6-astra',headline:item.caption}),Date.now());
 for(const platform of ['wibes','ozon'])assert.equal((await request('/reel-jobs/'+id+'/caption-plan',{claim_id:claim,plan:{content_id:id,policy_id:'source-caption',platforms:{[platform]:item}}})).status,422);
 assert.equal((await request('/reel-jobs/'+id+'/caption-plan',{claim_id:claim,plan:{content_id:id,policy_id:'source-caption',platforms:{threads:item}}})).status,200);
});

test('seven verified destinations complete a historical nine-destination job; verified proofs may append later',async()=>{
 const id='full-seven-api',claim='full-seven-claim',stamp=new Date().toISOString();
 sqlite.prepare('INSERT INTO ugc_content VALUES(?,?,?,?)').run(id,'profile','https://instagram.com/reel/FULLSOURCE/','video');
 const required=['instagram','threads','youtube','facebook','vk','rutube','tiktok','wibes','ozon'];
 sqlite.prepare("INSERT INTO ugc_reel_jobs(content_id,requested_by,requested_at,updated_at,status,claim_id,required_destinations)VALUES(?,?,?,?,?,?,?)").run(id,'owner',stamp,stamp,'working',claim,JSON.stringify(required));
 const urls={instagram:'https://instagram.com/reel/FULLDEST/',threads:'https://threads.com/@dasexperten/post/FULLDEST',youtube:'https://youtube.com/watch?v=AbC123def_0',facebook:'https://facebook.com/reel/1234567890/',vk:'https://vk.ru/video-229095983_456240575',rutube:'https://rutube.ru/video/0123456789abcdef0123456789abcdef/',tiktok:'https://tiktok.com/@dasbroadcast/video/1234567890',wibes:'https://wibes.ru/clips/verified-video',ozon:'https://ozon.ru/product/3570424416/'};
 const proofs=required.map(platform=>({...(['wibes','ozon'].includes(platform)?{publication_transport:'api'}:{}),...(platform==='ozon'?{placement:'product_video',ozon_sku:'3570424416',ozon_video_url:'https://v-1.ozone.ru/vod/video-67/verified/asset_1_h264.mp4'}:{}),platform,url:urls[platform],account:platform==='tiktok'?'dasbroadcast':'dasexperten',verified:true,verified_at:stamp,evidence:'Official API public original and exact account verified'}));
 for(const missing of required.filter(p=>!['wibes','ozon'].includes(p))){
  const res=await request('/reel-jobs/'+id+'/complete',{claim_id:claim,publications:proofs.filter(p=>p.platform!==missing)});
  assert.equal(res.status,422,missing);assert.deepEqual((await res.json()).missing,[missing]);
  assert.equal(sqlite.prepare('SELECT status FROM ugc_reel_jobs WHERE content_id=?').get(id).status,'working');
 }
 const seven=proofs.filter(p=>!['wibes','ozon'].includes(p.platform));
 const beforeScope=sqlite.prepare('SELECT required_destinations FROM ugc_reel_jobs WHERE content_id=?').get(id).required_destinations;
 const completed=await request('/reel-jobs/'+id+'/complete',{claim_id:claim,publications:seven});assert.equal(completed.status,200);
 const result=await completed.json();assert.equal(result.status,'published');assert.equal(result.publications.length,7);assert.deepEqual(result.destination_scope.optional,[]);assert.deepEqual(result.destination_scope.deferred,['wibes','ozon']);
 const original=sqlite.prepare('SELECT required_destinations,published_at FROM ugc_reel_jobs WHERE content_id=?').get(id);assert.equal(original.required_destinations,beforeScope);
 const appended=await request('/reel-jobs/'+id+'/publications',{publications:proofs.filter(p=>['wibes','ozon'].includes(p.platform))});assert.equal(appended.status,200);assert.equal((await appended.json()).publications.length,9);
 assert.equal(sqlite.prepare('SELECT published_at FROM ugc_reel_jobs WHERE content_id=?').get(id).published_at,original.published_at);
});

test('TikTok transport endpoints require the existing service credential and reject invalid source identity',async()=>{
 assert.equal((await request('/reel-jobs/reel1/tiktok/start',{claim_id:'test'},false)).status,401);
 assert.equal((await request('/reel-jobs/reel1/tiktok/status?source_sha256='+'a'.repeat(64),undefined,false)).status,401);
 assert.equal((await request('/reel-jobs/reel1/tiktok/start',{claim_id:'test',source_sha256:'invalid'})).status,409);
 assert.equal((await request('/reel-jobs/reel1/tiktok/status?source_sha256=invalid')).status,422);
});

test('known accepted API publications retain their claim while processing instead of being blocked or released',async()=>{
 const id='known-api-pending',claim='known-api-claim',stamp=new Date().toISOString();
 sqlite.prepare('INSERT INTO ugc_content VALUES(?,?,?,?)').run(id,'profile','https://instagram.com/reel/KNOWNAPI/','video');
 sqlite.prepare("INSERT INTO ugc_reel_jobs(content_id,requested_by,requested_at,updated_at,status,claim_id,required_destinations,attempts)VALUES(?,?,?,?,?,?,?,?)").run(id,'owner',stamp,stamp,'working',claim,'["rutube","tiktok"]',1);
 sqlite.prepare('INSERT INTO crm_sync_state VALUES(?,?,0)').run('ugc-tiktok-business:'+id+':'+'a'.repeat(64),JSON.stringify({state:'accepted',identity:{claimId:claim}}));
 const body={claim_id:claim,video_id:'0123456789abcdef0123456789abcdef',source_sha256:'a'.repeat(64),duration_seconds:13};
 assert.equal((await request('/reel-jobs/'+id+'/rutube/pending',body,false)).status,401);
 assert.equal((await request('/reel-jobs/'+id+'/rutube/pending',body)).status,200);
 assert.equal((await request('/reel-jobs/'+id+'/rutube/pending',body)).status,200);
 assert.equal((await request('/reel-jobs/'+id+'/rutube/pending',{...body,video_id:'1123456789abcdef0123456789abcdef'})).status,409);
 for(const action of ['release','block']){
  const response=await(await request('/reel-jobs/'+id+'/'+action,{claim_id:claim,error:'Known providers still processing',failed_attempts:3})).json();assert.equal(response.status,'working');assert.equal(response.api_completion_pending,true);
 }
 const row=sqlite.prepare('SELECT status,claim_id,attempts FROM ugc_reel_jobs WHERE content_id=?').get(id);assert.equal(row.status,'working');assert.equal(row.claim_id,claim);assert.equal(row.attempts,1);
});

test('long diagnostic is protected, exact-incident gated, fixed and its late result is GET only',async()=>{
 const stopKey='dieter_cloud_runtime_stop',old=sqlite.prepare('SELECT value FROM crm_sync_state WHERE key=?').get(stopKey);
 const priorJobs=sqlite.prepare("SELECT content_id,status FROM ugc_reel_jobs WHERE status='working'").all();
 let calls=[];env.DIETER_SUBSCRIPTION={async fetch(url,init){calls.push({url,init});return Response.json({diagnostic:true});}};
 try{
  assert.equal((await request('/cloud/runtime-probe',{claim_id:'claim',request_id:'runtime-probe:one'},false)).status,401);
  sqlite.prepare('INSERT OR REPLACE INTO crm_sync_state VALUES(?,?,0)').run(stopKey,JSON.stringify({claim_id:'incident'}));
  assert.equal((await request('/cloud/runtime-probe',{claim_id:'wrong',request_id:'runtime-probe:one'})).status,409);
  assert.equal((await request('/cloud/runtime-probe',{claim_id:'incident',request_id:'work-id'})).status,422);
  sqlite.exec("UPDATE ugc_reel_jobs SET status='queued' WHERE status='working'");
  assert.equal((await request('/cloud/runtime-probe',{claim_id:'incident',request_id:'runtime-probe:one',command:'must-never-forward',model:'must-never-forward'})).status,200);
  assert.deepEqual(JSON.parse(calls[0].init.body),{requestId:'runtime-probe:one'});
  assert.equal((await request('/cloud/runtime-result/runtime-probe%3Aone')).status,200);assert.equal(calls[1].init.method,'GET');assert.match(calls[1].url,/result\/runtime-probe%3Aone$/);
  assert.equal((await request('/cloud/runtime-result/dieter-work-id')).status,422);assert.equal(calls.length,2);
 }finally{delete env.DIETER_SUBSCRIPTION;sqlite.prepare('DELETE FROM crm_sync_state WHERE key=?').run(stopKey);if(old)sqlite.prepare('INSERT INTO crm_sync_state VALUES(?,?,0)').run(stopKey,old.value);for(const j of priorJobs)sqlite.prepare('UPDATE ugc_reel_jobs SET status=? WHERE content_id=?').run(j.status,j.content_id);}
});


test('Alexandra Astra headline is source-bound, saved once and retained across claim retries',async()=>{
 const id='astra-headline',claim='astra-claim';
 sqlite.prepare('INSERT INTO ugc_content VALUES(?,?,?,?)').run(id,'profile','https://instagram.com/reel/ASTRA/','video');
 sqlite.prepare("INSERT INTO ugc_reel_jobs(content_id,requested_by,requested_at,updated_at,status,claim_id)VALUES(?,?,?,?,?,?)").run(id,'owner','now','now','working',claim);
 const result={candidates:['Что заметила Евгения у зеркала?','Евгения у зеркала: одна деталь меняет утро','Зачем Евгения задержалась у зеркала?'].map(headline=>({headline,angle:'scene-specific',source_evidence:'Exact transcript'})),selected_index:0,selection_reason:'real scene',payoff:'Exact transcript payoff',checks:{source_grounded:true,intrigue:true,viewer_interest:true,unique_to_reel:true,truthful:true}};
 let calls=0;env.CODEX_ROUTE_SECRET='fixture';env.CODEX_DOOR={async fetch(_,init){calls++;assert.equal(JSON.parse(init.body).model,'gpt-6-astra');return Response.json({ok:true,model:'gpt-6-astra',text:JSON.stringify(result)});}};
 const brief={author:'evgeniya.ilyna',source_caption:'Exact caption',scene_evidence:'Exact transcript',verified_products:[],profile_context:'Loaded Alexandra voice and charter'};
 assert.equal((await request('/reel-jobs/'+id+'/headline',{claim_id:'wrong',brief})).status,409);
 assert.equal((await request('/reel-jobs/'+id+'/headline',{claim_id:claim,brief:{}})).status,422);
 const first=await(await request('/reel-jobs/'+id+'/headline',{claim_id:claim,brief})).json();assert.equal(first.model,'gpt-6-astra');assert.equal(first.headline,result.candidates[0].headline);
 sqlite.prepare('UPDATE ugc_reel_jobs SET claim_id=? WHERE content_id=?').run('retry',id);
 const retry=await(await request('/reel-jobs/'+id+'/headline',{claim_id:'retry',brief})).json();assert.equal(retry.headline,first.headline);assert.equal(calls,1);
 delete env.CODEX_DOOR;delete env.CODEX_ROUTE_SECRET;
});
