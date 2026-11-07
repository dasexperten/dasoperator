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
const { tickDiterAlarm, diterWindow, acceptLegacyReel } = await import(pathToFileURL(join(temp,'store.mjs')).href);
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
const monday = Date.parse('2026-11-09T09:15:00Z'); // 12:15 Moscow
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
  resetAlarm();
});
test('Moscow windows exactly preserve days and half-open boundaries',()=>{
  const check=(s,expected)=>assert.equal(diterWindow(Date.parse(s)),expected,s);
  check('2026-11-07T09:30:00Z',false); // Saturday
  check('2026-11-08T16:29:59Z',false);check('2026-11-08T16:30:00Z',true);check('2026-11-08T18:30:00Z',false);
  check('2026-11-09T05:00:00Z',false);check('2026-11-10T05:00:00Z',true);check('2026-11-10T07:30:00Z',false);
  check('2026-11-09T09:14:59Z',false);check('2026-11-09T09:15:00Z',true);check('2026-11-09T10:30:00Z',false);
  check('2026-11-11T16:30:00Z',true);check('2026-11-12T16:30:00Z',false);
});
test('alarm stays red without live consumer or outside windows; atomic one-job acceptance then exact assignment',async()=>{
  insert();resetAlarm();
  assert.equal((await request('/alarm/status',undefined,false)).status,401);
  assert.equal((await request('/alarm/pulse',{consumer_id:'mac-dieter-test',ready:true,capabilities:[]})).status,422);
  assert.equal((await tickDiterAlarm(env,monday)).note,'consumer_missing');assert.equal(row().status,'queued');
  ready(Date.parse('2026-11-07T09:15:00Z'));
  assert.equal((await tickDiterAlarm(env,Date.parse('2026-11-07T09:15:00Z'))).note,'outside_window');assert.equal(row().status,'queued');
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
  assert.equal((await tickDiterAlarm(env,monday+16*60000)).note,'working_job_exists');
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
  ready(monday+14*60000);assert.equal((await tickDiterAlarm(env,monday+14*60000)).note,'cooldown');
  for(let i=0;i<3;i++) {
    const now=monday+(i+1)*15*60000;ready(now);
    assert.equal((await tickDiterAlarm(env,now)).accepted,true);
    const job=sqlite.prepare("SELECT * FROM ugc_reel_jobs WHERE content_id='reel2'").get();
    assert.equal((await request('/reel-jobs/reel2/release',{claim_id:job.claim_id,error:'No authenticated upload access'})).status,200);
  }
  ready(monday+60*60000);assert.equal((await tickDiterAlarm(env,monday+60*60000)).note,'empty');
  sqlite.exec('DELETE FROM ugc_reel_jobs');
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
  assert.deepEqual(JSON.parse(row().required_destinations),['instagram','threads','vk','youtube','tiktok']);
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
