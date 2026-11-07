import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const temp = mkdtempSync(join(tmpdir(),'ugc-reel-test-'));
const root = new URL('../../../', import.meta.url);
await build({ entryPoints: [fileURLToPath(new URL('../routes/internal-ugc.ts', import.meta.url))], bundle:true, platform:'node', format:'esm', outfile:join(temp,'route.mjs'),logLevel:'silent' });
await build({ entryPoints: [fileURLToPath(new URL('./ugc-reel-store.ts', import.meta.url))], bundle:true, platform:'node', format:'esm', outfile:join(temp,'store.mjs'),logLevel:'silent' });
await build({ entryPoints: [fileURLToPath(new URL('../routes/ugc.ts', import.meta.url))], bundle:true, platform:'node', format:'esm', outfile:join(temp,'ugc.mjs'),logLevel:'silent' });
const ownerRoute = (await import(pathToFileURL(join(temp,'ugc.mjs')).href)).default;
const route = (await import(pathToFileURL(join(temp,'route.mjs')).href)).default;
const { dispatchReel, tickDiterUgcAlarm } = await import(pathToFileURL(join(temp,'store.mjs')).href);
const ActualDate = Date;
let clock = ActualDate.parse('2026-11-10T09:15:00.000Z');
globalThis.Date = class extends ActualDate {
  constructor(...args) { super(...(args.length ? args : [clock])); }
  static now() { return clock; }
};
const advance = () => { clock += 15 * 60000; };
const sqlite = new DatabaseSync(':memory:');
sqlite.exec('CREATE TABLE crm_sync_state(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER)');
sqlite.exec(`CREATE TABLE ugc_content(id TEXT PRIMARY KEY,creator_platform_id TEXT,content_url TEXT,content_type TEXT); CREATE TABLE ugc_creator_platforms(id TEXT PRIMARY KEY,handle TEXT,platform TEXT);`);
sqlite.exec(readFileSync(new URL('db/migrations/0157_ugc_reel_jobs.sql',root),'utf8'));
sqlite.exec(`INSERT INTO ugc_content VALUES('reel1','profile','https://instagram.com/reel/SOURCE/','video'); INSERT INTO ugc_creator_platforms VALUES('profile','real_author','instagram');`);
const DB = { prepare(sql) { return { values:[], bind(...values){this.values=values;return this;}, async first(){return sqlite.prepare(sql).get(...this.values) ?? null;}, async all(){return {results:sqlite.prepare(sql).all(...this.values)};}, async run(){const result=sqlite.prepare(sql).run(...this.values);return {meta:{changes:Number(result.changes)}};} }; } };
const env = {DB,EMAILER_SERVICE_SECRET:'test-only-service-secret'};
const request = async (path,body,authorized=true) => {
  const headers = {'Content-Type':'application/json',...(authorized?{'X-Emailer-Service-Secret':env.EMAILER_SERVICE_SECRET}:{})};
  return route.request(`https://erp.test${path}`,{method:body===undefined?'GET':'POST',headers,...(body===undefined?{}:{body:JSON.stringify(body)})},env,{waitUntil(){},passThroughOnException(){}});
};
sqlite.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,role TEXT,active INTEGER,permissions TEXT);CREATE TABLE sessions(token TEXT PRIMARY KEY,user_id TEXT,expires_at INTEGER);
INSERT INTO users VALUES('owner','Owner','admin',1,'{}');INSERT INTO users VALUES('staff','Staff','manager',1,'{"/ugc":"rw"}');`);
for(const [token,user] of [['owner-session-token','owner'],['staff-session-token','staff']]) sqlite.prepare('INSERT INTO sessions VALUES(?,?,?)').run(token,user,Date.now()+86400000);
const insert = () => sqlite.exec(`INSERT OR IGNORE INTO ugc_reel_jobs(content_id,requested_by,requested_at,updated_at) VALUES('reel1','owner','2026-11-07T00:00:00.000Z','2026-11-07T00:00:00.000Z')`);
const row = () => sqlite.prepare('SELECT * FROM ugc_reel_jobs').get();
test('service auth, exclusive claim, proof validation and persistence',async()=>{
  insert();
  await tickDiterUgcAlarm(env);
  assert.equal((await request('/reel-jobs',undefined,false)).status,401);
  assert.equal((await request('/reel-jobs/reel1/claim',{},false)).status,401);
  let res=await request('/reel-jobs/reel1/claim',{});assert.equal(res.status,200);
  const claim=(await res.json()).claim_id;
  assert.equal(row().status,'working');
  assert.equal((await request('/reel-jobs/reel1/claim',{})).status,409);
  assert.equal((await request('/reel-jobs/reel1/complete',{claim_id:claim,publications:[]})).status,422);
  assert.equal(row().status,'working');
  const proof={platform:'instagram',url:'https://instagram.com/reel/NEWPOST/',account:'dasexperten',verified:true,verified_at:new Date().toISOString(),evidence:'Opened the new post and checked account, video and author credit'};
  assert.equal((await request('/reel-jobs/reel1/complete',{claim_id:'stale',publications:[proof]})).status,409);
  assert.equal((await request('/reel-jobs/reel1/complete',{claim_id:claim,publications:[proof]})).status,200);
  assert.equal(row().status,'published');
  assert.equal(JSON.parse(row().publications)[0].url,proof.url);
  const jobs=await(await request('/reel-jobs')).json();assert.equal(jobs.jobs[0].claim_id,undefined);
});
test('ERP alarm delivery stays red and never calls the model-only cloud shell',async()=>{
  sqlite.exec('DELETE FROM ugc_reel_jobs');insert();
  const calls=[];
  const SEAT_DIETER_VFX={async fetch(...args){calls.push(args);return Response.json({ok:true});}};
  await dispatchReel({...env,SEAT_DIETER_VFX},'reel1','https://erp.test');
  assert.equal(calls.length,0);assert.equal(row().status,'queued');
  assert.equal(row().attempts,0);assert.equal(row().dispatch_attempts,0);
  const alarm=await(await request('/reel-alarm')).json();
  assert.equal(alarm.name,'diter-ugc-alarm');assert.equal(alarm.target,'diter-ugc-round');
  assert.equal(alarm.ready,true);assert.match(alarm.job.task,/SOURCE/);
  assert.equal(alarm.job.publications,row().publications,'consumer receives durable placements before any new upload');
  await dispatchReel(env,'reel1','https://erp.test');
  assert.equal(row().dispatch_attempts,0,'offline consumer does not burn execution attempts');
});
test('release never auto-loops and the third failed work attempt is the last',async()=>{
  for(let i=0;i<3;i++){
    if(i) advance();
    await tickDiterUgcAlarm(env);
    const res=await request('/reel-jobs/reel1/claim',{});assert.equal(res.status,200);
    const claim=(await res.json()).claim_id;
    assert.equal((await request('/reel-jobs/reel1/release',{claim_id:claim,error:'No download access'})).status,200);
  }
  assert.equal((await request('/reel-jobs/reel1/claim',{})).status,409);
  assert.equal(row().status,'queued');assert.equal(row().attempts,3);assert.equal(row().last_error,'No download access');
});
test('real Owner endpoint authorizes selection and persists one job/wake for repeated clicks',async()=>{
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
test('working progress persists verified placements without green, rejects stale claims and complete merges',async()=>{
  sqlite.exec('DELETE FROM ugc_reel_jobs');insert();
  clock=ActualDate.parse('2026-11-10T09:15:00.000Z');await tickDiterUgcAlarm(env);
  const claim=(await(await request('/reel-jobs/reel1/claim',{})).json()).claim_id;
  const proof={platform:'instagram',url:'https://instagram.com/reel/PROGRESS/',account:'dasexperten',verified:true,verified_at:new Date().toISOString(),evidence:'Opened our uploaded video with author credit'};
  assert.equal((await request('/reel-jobs/reel1/progress',{claim_id:'wrong',publications:[proof]})).status,409);
  assert.equal((await request('/reel-jobs/reel1/progress',{claim_id:claim,publications:[{...proof,verified:false}]})).status,422);
  let res=await request('/reel-jobs/reel1/progress',{claim_id:claim,publications:[proof]});
  assert.equal(res.status,200);assert.equal(row().status,'working');assert.equal(row().published_at,null);
  res=await request('/reel-jobs/reel1/progress',{claim_id:claim,publications:[proof]});assert.equal((await res.json()).added,0);
  const other={...proof,platform:'threads',url:'https://threads.net/@dasexperten/post/SECOND/'};
  assert.equal((await request('/reel-jobs/reel1/complete',{claim_id:claim,publications:[other]})).status,200);
  assert.equal(row().status,'published');assert.equal(JSON.parse(row().publications).length,2);
  assert.equal((await request('/reel-jobs/reel1/progress',{claim_id:claim,publications:[proof]})).status,409);
});
test('server gates outside windows, stale signals, distinct concurrent jobs and exact 15-minute gap',async()=>{
  sqlite.exec('DELETE FROM ugc_reel_jobs');insert();
  sqlite.exec(`INSERT OR IGNORE INTO ugc_content VALUES('reel2','profile','https://instagram.com/reel/SOURCE2/','video');
    INSERT INTO ugc_reel_jobs(content_id,requested_by,requested_at,updated_at) VALUES('reel2','owner','2026-11-07T00:00:01.000Z','2026-11-07T00:00:01.000Z')`);
  clock=ActualDate.parse('2026-11-10T07:30:00.000Z'); // 10:30 Moscow: closed
  await tickDiterUgcAlarm(env);
  assert.equal((await request('/reel-jobs/reel1/claim',{})).status,409);
  assert.equal((await(await request('/reel-alarm')).json()).ready,false);
  clock=ActualDate.parse('2026-11-10T09:15:00.000Z');
  await tickDiterUgcAlarm(env);clock+=3*60000;
  assert.equal((await request('/reel-jobs/reel1/claim',{})).status,409,'stale signal cannot launch');
  await tickDiterUgcAlarm(env);
  const starts=await Promise.all([request('/reel-jobs/reel1/claim',{}),request('/reel-jobs/reel2/claim',{}),request('/reel-jobs/reel1/claim',{})]);
  assert.deepEqual(starts.map(r=>r.status).sort(),[200,409,409]);
  const claim=(await starts[0].json()).claim_id;
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM ugc_reel_jobs WHERE status='working'").get().n,1);
  clock+=16*60000;await tickDiterUgcAlarm(env);
  assert.equal((await request('/reel-jobs/reel2/claim',{})).status,409,'working post blocks another even past cooldown');
  assert.equal((await request('/reel-jobs/reel1/release',{claim_id:claim,error:'Fixture access block'})).status,200);
  // A released start still contributes to cooldown, and it cannot be erased by retries.
  clock=ActualDate.parse(row().started_at)+15*60000-1;
  await tickDiterUgcAlarm(env);
  assert.equal((await request('/reel-jobs/reel1/claim',{})).status,409);
  clock+=1;await tickDiterUgcAlarm(env);
  assert.equal((await request('/reel-jobs/reel1/claim',{})).status,200);
});
test.after(()=>{globalThis.Date=ActualDate;sqlite.close();rmSync(temp,{recursive:true,force:true});});
