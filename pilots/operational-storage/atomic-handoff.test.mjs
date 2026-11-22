import {test,before,after,describe} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createAtomicHandoffService,createAtomicHandoffEndpoint,canonicalHandoffRequest,handoffSourceKey} from './atomic-handoff.mjs';
const config={namespace:'pilot-atomic',agents:{angela:'shadow','diana-helios':'off'}};
const scope=id=>({namespace:'pilot-atomic',agent:'angela',spreadsheetId:'synthetic-spreadsheetId',tabId:1,caseId:id});
const key=id=>handoffSourceKey(scope(id));
const settings={agent:'angela',config};
const input=(id,stage='')=>({...scope(id),sourceKey:key(id),checkpoint:'cp1',identityVersion:'identity1',decisionVersion:'decision1',manualStage:stage,responseRef:'synthetic-reply',discussionRef:'synthetic-substantive-discussion'});
test('default off and missing trusted integration fail before database or body access',async()=>{
 await assert.rejects(createAtomicHandoffService().transfer(null),/disabled/);
 await assert.rejects(createAtomicHandoffService({...settings}).transfer(input('x')),/integration_missing/);
 assert.equal((await createAtomicHandoffEndpoint()(null)).status,503);
 assert.equal((await createAtomicHandoffEndpoint({...settings})(null)).status,503);
});
test('exact bounded inputs reject authorization flags, accessors, missing values and bad strings',()=>{
 for(const v of [{...input('x'),approved:true},{...input('x'),sourceKey:''},{...input('x'),checkpoint:'x'.repeat(1025)},{...input('x'),checkpoint:'\n'},Object.assign(Object.create({a:1}),input('x'))]) assert.throws(()=>canonicalHandoffRequest(v));
 const v=input('x');Object.defineProperty(v,'checkpoint',{get(){throw Error('getter executed');},enumerable:true});assert.throws(()=>canonicalHandoffRequest(v),/invalid_request_fields/);
});
test('own-property per-agent activation and factory snapshots reject inherited/global activation',async()=>{
 assert.throws(()=>createAtomicHandoffService({enabled:true}),/invalid_request_fields/);
 assert.throws(()=>createAtomicHandoffService(Object.create(settings)),/invalid_request_fields/);
 assert.throws(()=>createAtomicHandoffService({...settings,config:{namespace:'pilot-atomic',agents:Object.create({angela:'shadow'})}}),/invalid_request_fields/);
 const mutable={agent:'angela',config:{namespace:'pilot-atomic',agents:{angela:'off','diana-helios':'shadow'}}};
 const endpoint=createAtomicHandoffEndpoint(mutable);mutable.config.agents.angela='shadow';
 assert.equal((await endpoint(null)).status,503);
 let calls=0;const service=createAtomicHandoffService({...settings,verifyTrustedSource:async()=>{calls++;return null;}});
 for(const change of [{agent:'diana-helios'},{namespace:'pilot-other'},{spreadsheetId:'wrong-spreadsheetId'}]) {
  const request={...input('scope'),...change};if(!change.spreadsheetId)request.sourceKey=handoffSourceKey(request);
  await assert.rejects(service.transfer(request),/scope/);
 }assert.equal(calls,0);
});
test('slow body and verifier time out without late DB writes; callback errors sanitized',async()=>{
 let writes=0,resolveVerifier,cancelled=false;
 const db={batch:()=>{writes++;throw Error('unexpected');}};
 const endpoint=createAtomicHandoffEndpoint({...settings,db,timeoutMs:20,verifyTrustedSource:()=>new Promise(resolve=>{resolveVerifier=resolve;})});
 const req=()=>new Request('http://synthetic.invalid/',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input('slow'))});
 const response=await endpoint(req());assert.equal(response.status,409);resolveVerifier(key('slow'));
 await new Promise(resolve=>setTimeout(resolve,30));assert.equal(writes,0);
 const slow=new Request('http://synthetic.invalid/',{method:'POST',headers:{'content-type':'application/json'},duplex:'half',body:new ReadableStream({cancel(){cancelled=true;}})});
 assert.equal((await endpoint(slow)).status,409);assert.equal(cancelled,true);assert.equal(writes,0);
 const bad=createAtomicHandoffEndpoint({...settings,db,verifyTrustedSource:()=>{throw {get message(){throw Error('must not inspect');}};}});
 assert.deepEqual(await (await bad(req())).json(),{error:'handoff_rejected_or_unknown',retry:'same_request_only'});
});
test('already-dispatched DB timeout stays unknown and is not retried automatically',async()=>{
 let calls=0,finish;
 const statement={bind(){return this;}};
 const service=createAtomicHandoffService({...settings,timeoutMs:20,verifyTrustedSource:async r=>r.sourceKey,db:{prepare:()=>statement,batch:()=>{calls++;return new Promise(resolve=>{finish=resolve;});}}});
 await assert.rejects(service.transfer(input('uncertain')),/deadline/);
 finish([{},{results:[{source_key:key('uncertain'),request_json:canonicalHandoffRequest(input('uncertain')),creator_id:'c',profile_id:'p',collaboration_id:'x'}]}]);
 await new Promise(resolve=>setTimeout(resolve,20));assert.equal(calls,1);
});
test('malformed or failed readback never reports success',async()=>{
 const request=input('malformed');
 const row={source_key:request.sourceKey,request_json:canonicalHandoffRequest(request),creator_id:'c',profile_id:'p',collaboration_id:'x'};
 const good=()=>[{success:true,results:[]},{success:true,results:[{...row}]}];
 const variants=[null,[],[{}],good(),good(),good(),good(),good(),good(),good(),good(),good()];
 variants[3][0].success=false;variants[4][1].success=false;variants[5][1].results=[];
 variants[6][1].results.push({...row});variants[7][1].results[0].source_key='wrong';
 delete variants[8][1].results[0].creator_id;variants[9][1].results[0].profile_id='';
 variants[10][1].results[0].collaboration_id='bad\n';variants[11][1].results[0].request_json='wrong';
 for(const result of variants){
  const statement={bind(){return this;}};
  const service=createAtomicHandoffService({...settings,verifyTrustedSource:async r=>r.sourceKey,db:{prepare:()=>statement,batch:async()=>result}});
  await assert.rejects(service.transfer(request));
 }
});
test('body and verifier share one total deadline with no late dispatch',async()=>{
 let writes=0,verifierStarted=false,verifierFinished=false;
 const endpoint=createAtomicHandoffEndpoint({...settings,timeoutMs:180,db:{batch(){writes++;}},verifyTrustedSource:async request=>{
  verifierStarted=true;await new Promise(resolve=>setTimeout(resolve,120));verifierFinished=true;return request.sourceKey;
 }});
 const bytes=new TextEncoder().encode(JSON.stringify(input('combined')));
 const request=new Request('http://synthetic.invalid/',{method:'POST',headers:{'content-type':'application/json'},duplex:'half',body:new ReadableStream({async start(controller){await new Promise(resolve=>setTimeout(resolve,100));controller.enqueue(bytes);controller.close();}})});
 assert.equal((await endpoint(request)).status,409);assert.equal(verifierStarted,true);
 assert.equal(verifierFinished,false);await new Promise(resolve=>setTimeout(resolve,160));
 assert.equal(verifierFinished,true);assert.equal(writes,0);
});
describe('isolated native workerd D1 atomic handoff',{skip:!process.env.MINIFLARE_MODULE},()=>{
 let mf,db,outbound=0;
 before(async()=>{
  const {Miniflare,Log,LogLevel}=await import(pathToFileURL(process.env.MINIFLARE_MODULE));
  mf=new Miniflare({modules:true,scriptPath:fileURLToPath(new URL('./atomic-handoff.fixture-worker.mjs',import.meta.url)),modulesRoot:fileURLToPath(new URL('./',import.meta.url)),compatibilityDate:'2026-07-30',host:'127.0.0.1',port:0,cf:false,d1Databases:{DB:'synthetic-atomic-handoff'},d1Persist:false,log:new Log(LogLevel.NONE),outboundService:()=>{outbound++;return new Response('denied',{status:403});}});
  db=await mf.getD1Database('DB');
  const schema=await readFile(new URL('./atomic-handoff.schema.sql',import.meta.url),'utf8');
  await db.batch(schema.replace(/^\s*--.*$/gm,'').split(/(?=^CREATE (?:TABLE|TRIGGER)\b)/m).map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
 });
 after(async()=>{if(mf)await mf.dispose();});
 const call=(v,extra={})=>mf.dispatchFetch('http://synthetic.invalid/',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(v),...extra});
 async function seed(id,{mode='new',stage='',coverage='complete',state='current',outcome='settled',platform='instagram',collab=`collab-${id}`}={}) {
  const v=input(id,stage);
  if(mode==='existing') {
   await db.prepare('INSERT INTO atomic_creators VALUES (?,?,?)').bind(`creator-${id}`,stage,'manual1').run();
   await db.prepare('INSERT INTO atomic_profiles VALUES (?,?,?,?)').bind(`profile-${id}`,`creator-${id}`,platform,`renamed-${id}`).run();
   await db.prepare('INSERT INTO atomic_aliases VALUES (?,?)').bind(`old-${id}`,`profile-${id}`).run();
  }
  await db.prepare('INSERT INTO atomic_source VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(key(id),canonicalHandoffRequest(v),`creator-${id}`,`profile-${id}`,collab,mode,mode==='existing'?`renamed-${id}`:`handle-${id}`,stage,'manual1',platform,coverage,state,outcome,v.responseRef,v.discussionRef,'substantive').run();return v;
 }
 async function count(table,id){return (await db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${table==='atomic_handoffs'?'source_key':'id'}=?`).bind(table==='atomic_handoffs'?key(id):id).first()).n;}
 test('new transaction and concurrent exact retries create one mapping and collaboration',async()=>{
  const v=await seed('race');const responses=await Promise.all(Array.from({length:8},()=>call(v)));assert.ok(responses.every(r=>r.status===200));
  const results=await Promise.all(responses.map(r=>r.json()));assert.ok(results.every(r=>JSON.stringify(r)===JSON.stringify(results[0])));
  assert.equal(await count('atomic_handoffs','race'),1);assert.equal(await count('atomic_collaborations','collab-race'),1);
  assert.equal((await db.prepare('SELECT lifecycle_stage FROM atomic_creators WHERE id=?').bind('creator-race').first()).lifecycle_stage,'');
 });
 test('existing renamed identity retains actual IDs and manual stage',async()=>{
  const v=await seed('rename',{mode:'existing',stage:'refused'});const r=await (await call(v)).json();assert.equal(r.creatorId,'creator-rename');assert.equal(r.profileId,'profile-rename');
  assert.equal((await db.prepare('SELECT lifecycle_stage FROM atomic_creators WHERE id=?').bind(r.creatorId).first()).lifecycle_stage,'refused');
 });
 test('stale source, decision, stage and changed request fail without side effects',async()=>{
  const v=await seed('stale',{mode:'existing'});
  for(const field of ['checkpoint','decisionVersion','identityVersion','responseRef','discussionRef','manualStage']) assert.equal((await call({...v,[field]:'changed'})).status,409);
  await db.prepare("UPDATE atomic_creators SET manual_revision='manual2' WHERE id='creator-stale'").run();assert.equal((await call(v)).status,409);assert.equal(await count('atomic_handoffs','stale'),0);
 });
 test('purged aliases, missing coverage, unknown outcomes and unsupported platforms block',async()=>{
  const alias=await seed('purge',{mode:'existing'});await db.prepare("INSERT INTO atomic_exclusions VALUES ('old-purge')").run();assert.equal((await call(alias)).status,409);
  for(const [id,opts] of [['coverage',{coverage:'unknown'}],['unknown',{outcome:'unknown'}],['deleted',{state:'deleted'}],['platform',{platform:'tiktok'}]]) {assert.equal((await call(await seed(id,opts))).status,409);assert.equal(await count('atomic_creators',`creator-${id}`),0);}
 });
 test('existing collaboration collision rejects before creating any rows',async()=>{
  const v=await seed('early-collision',{collab:'collab-race'});
  const service=createAtomicHandoffService({...settings,db,verifyTrustedSource:async request=>request.sourceKey});
  await assert.rejects(service.transfer(v),/cross_source_collaboration_conflict/);
  for(const [table,id] of [['atomic_creators','creator-early-collision'],['atomic_profiles','profile-early-collision'],['atomic_handoffs','early-collision']]) assert.equal(await count(table,id),0);
  assert.equal((await db.prepare("SELECT creator_id FROM atomic_collaborations WHERE id='collab-race'").first()).creator_id,'creator-race');
 });
 test('fixture collaboration abort after inserts rolls back all rows and preserves source/unrelated data',async()=>{
  await db.prepare(`CREATE TRIGGER atomic_fixture_late_conflict BEFORE INSERT ON atomic_collaborations
   WHEN NEW.id='fixture-unique-late-collaboration' BEGIN
   SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM atomic_creators WHERE id=NEW.creator_id)
    OR NOT EXISTS(SELECT 1 FROM atomic_profiles WHERE creator_id=NEW.creator_id)
    OR NOT EXISTS(SELECT 1 FROM atomic_handoffs WHERE collaboration_id=NEW.id)
    THEN RAISE(ABORT,'fixture_expected_prior_inserts_missing') END;
   SELECT RAISE(ABORT,'synthetic_late_conflict'); END`).run();
  const v=await seed('rollback',{collab:'fixture-unique-late-collaboration'});
  const tables=['atomic_creators','atomic_profiles','atomic_collaborations','atomic_handoffs','atomic_source','atomic_aliases','atomic_exclusions'];
  const snapshot=()=>Promise.all(tables.map(async table=>(await db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results));
  const before=await snapshot();
  assert.equal((await call(v)).status,409);
  assert.deepEqual(await snapshot(),before);
  // The endpoint sanitizes errors. The same exact-key service call proves the
  // fixture abort ran only AFTER all three earlier INSERTs were visible.
  const service=createAtomicHandoffService({...settings,db,verifyTrustedSource:async request=>request.sourceKey});
  await assert.rejects(service.transfer(v),/synthetic_late_conflict/);
  for(const [table,id] of [['atomic_creators','creator-rollback'],['atomic_profiles','profile-rollback'],['atomic_handoffs','rollback'],['atomic_collaborations','fixture-unique-late-collaboration']]) assert.equal(await count(table,id),0);
  assert.deepEqual(await snapshot(),before);
 });
 test('lost committed response and separate Sheet acknowledgment failure never recreate',async()=>{
  const v=await seed('lost');await call(v); // Deliberately discard successful response.
  const result=await (await call(v)).json();assert.equal(result.creatorId,'creator-lost');
  // No Sheet writer exists. Its separate failure cannot mutate this mapping.
  assert.equal((await call({...v,checkpoint:'changed'})).status,409);
  assert.deepEqual(await (await call(v)).json(),result);assert.equal(await count('atomic_collaborations','collab-lost'),1);
  await db.prepare("DELETE FROM atomic_collaborations WHERE id='collab-lost'").run();assert.equal((await call(v)).status,409);assert.equal(await count('atomic_collaborations','collab-lost'),0);
 });
 test('deleted/merged existing profile cannot be recreated on replay',async()=>{
  const v=await seed('merge');assert.equal((await call(v)).status,200);
  await db.prepare("UPDATE atomic_profiles SET creator_id='creator-race' WHERE id='profile-merge'").run();assert.equal((await call(v)).status,409);assert.equal(await count('atomic_handoffs','merge'),1);
 });
 test('missing trusted source after commit blocks readback; fences resist mutation',async()=>{
  const v=await seed('missing');assert.equal((await call(v)).status,200);
  await assert.rejects(db.prepare("DELETE FROM atomic_handoffs WHERE source_key=?").bind(key('missing')).run(),/immutable_handoff/);
  await assert.rejects(db.prepare("UPDATE atomic_handoffs SET creator_id='other' WHERE source_key=?").bind(key('missing')).run(),/immutable_handoff/);
  await db.prepare("DELETE FROM atomic_source WHERE source_key=?").bind(key('missing')).run();assert.equal((await call(v)).status,409);
  assert.equal(await count('atomic_handoffs','missing'),1);
 });
 test('untrusted verifier rejection cannot write',async()=>{
  const v=await seed('denied');
  await assert.rejects(createAtomicHandoffService({...settings,db,verifyTrustedSource:async()=>null}).transfer(v),/verification_failed/);
  assert.equal(await count('atomic_handoffs','denied'),0);
 });
 test('withdrawn or preliminary qualification is fenced atomically even after verification',async()=>{
  for(const qualification of ['withdrawn','preliminary']) {
   const v=await seed(qualification);
   const service=createAtomicHandoffService({...settings,db,verifyTrustedSource:async request=>{
    await db.prepare('UPDATE atomic_source SET qualification=? WHERE source_key=?').bind(qualification,request.sourceKey).run();return request.sourceKey;
   }});
   await assert.rejects(service.transfer(v),/source_checkpoint_or_coverage_conflict/);
   assert.equal(await count('atomic_handoffs',qualification),0);assert.equal(await count('atomic_creators',`creator-${qualification}`),0);
  }
 });
 test('cross-source INSERT OR REPLACE preserves the original fence and collaboration',async()=>{
  assert.equal((await db.prepare('PRAGMA foreign_keys').first()).foreign_keys,1);
  assert.equal((await db.prepare('PRAGMA recursive_triggers').first()).recursive_triggers,0);
  const original=await seed('replace-original');assert.equal((await call(original)).status,200);
  const next=await seed('replace-next',{collab:'collab-replace-original'});
  const oldMapping=await db.prepare('SELECT * FROM atomic_handoffs WHERE source_key=?').bind(original.sourceKey).first();
  const oldCollaboration=await db.prepare("SELECT * FROM atomic_collaborations WHERE id='collab-replace-original'").first();
  await assert.rejects(db.prepare('INSERT OR REPLACE INTO atomic_handoffs VALUES (?,?,?,?,?)').bind(next.sourceKey,canonicalHandoffRequest(next),'creator-replace-next','profile-replace-next','collab-replace-original').run(),/cross_source_collaboration_conflict/);
  assert.deepEqual(await db.prepare('SELECT * FROM atomic_handoffs WHERE source_key=?').bind(original.sourceKey).first(),oldMapping);
  assert.deepEqual(await db.prepare("SELECT * FROM atomic_collaborations WHERE id='collab-replace-original'").first(),oldCollaboration);
  assert.equal(await count('atomic_handoffs','replace-next'),0);assert.equal(await count('atomic_creators','creator-replace-next'),0);
  await db.prepare("INSERT INTO atomic_collaborations VALUES ('standalone','creator-race','replied','r','d')").run();
  const standalone=await seed('replace-standalone',{collab:'standalone'});
  await assert.rejects(db.prepare('INSERT OR REPLACE INTO atomic_handoffs VALUES (?,?,?,?,?)').bind(standalone.sourceKey,canonicalHandoffRequest(standalone),'creator-replace-standalone','profile-replace-standalone','standalone').run(),/preexisting_collaboration_conflict/);
  assert.equal((await db.prepare("SELECT creator_id FROM atomic_collaborations WHERE id='standalone'").first()).creator_id,'creator-race');
 });
 test('invalid projected and target IDs reject atomically, preserving valid source state',async()=>{
  const v=await seed('bad-ids');
  for(const column of ['creator_id','profile_id','collaboration_id'])for(const value of ['',null,'bad\n','bad\u0000id','é','x'.repeat(257)]) {
   await assert.rejects(db.batch([
    db.prepare('INSERT INTO atomic_creators VALUES (?,?,?)').bind('would-rollback','','m'),
    db.prepare(`UPDATE atomic_source SET ${column}=? WHERE source_key=?`).bind(value,v.sourceKey),
   ]),/constraint/i);
   assert.equal(await count('atomic_creators','would-rollback'),0);
  }
  for(const sql of ["INSERT INTO atomic_creators VALUES (x'616263','','m')","INSERT INTO atomic_creators VALUES ('','','m')","INSERT INTO atomic_profiles VALUES ('','creator-race','instagram','bad')","INSERT INTO atomic_aliases VALUES ('bad','')","INSERT INTO atomic_collaborations VALUES ('','creator-race','replied','r','d')"])
   await assert.rejects(db.prepare(sql).run(),/constraint/i);
  assert.equal(await count('atomic_handoffs','bad-ids'),0);
  assert.equal((await call(v)).status,200);
 });
 test('endpoint bounds bodies, rejects malformed input, no network attempts',async()=>{
  assert.equal((await call(null,{body:'x'.repeat(8193)})).status,413);
  assert.equal((await call(null,{body:'{'})).status,409);
  assert.equal((await call({...input('race'),approved:true})).status,409);
  assert.equal(outbound,0);
 });
});
