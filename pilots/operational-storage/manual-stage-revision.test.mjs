import {test,describe,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {composeManualRevisionHandoffSchema} from './manual-stage-revision.compose.mjs';
import {createManualStageRevision} from './manual-stage-revision.mjs';
import {createErpHandoffPersistence} from './erp-handoff-persistence.mjs';
import {createAtomicHandoffService,canonicalHandoffRequest,handoffSourceKey} from './atomic-handoff.mjs';

const scopeOptions={namespace:'pilot-erp',agent:'angela',enabled:true};
test('invalid explicit creator identities fail before DB access',async()=>{
 const api=createManualStageRevision({prepare(){throw Error('DB should not be accessed');}},scopeOptions);
 for(const id of ['',null,'a\nb','a b','x'.repeat(257)])await assert.rejects(api.enroll(id),/invalid_manual_creator_id/);
});
test('activation requires own plain data fields and snapshots config',async()=>{
 const db={prepare(){throw Error('unexpected_db_access');}};
 for(const config of [Object.create(scopeOptions),{...scopeOptions,extra:true},{...scopeOptions,get enabled(){throw Error('getter_must_not_execute');}},null])
  assert.throws(()=>createManualStageRevision(db,config),/invalid_manual_options/);
 const previous=Object.fromEntries(['enabled','namespace','agent'].map(k=>[k,Object.getOwnPropertyDescriptor(Object.prototype,k)]));
 try {
  for(const [key,value] of Object.entries(scopeOptions))Object.defineProperty(Object.prototype,key,{configurable:true,value});
  await assert.rejects(createManualStageRevision(db,{}).enroll('prototype-polluted'),/disabled/);
  await assert.rejects(createManualStageRevision(db).enroll('prototype-default'),/disabled/);
 } finally {
  for(const key of ['enabled','namespace','agent']){delete Object.prototype[key];if(previous[key])Object.defineProperty(Object.prototype,key,previous[key]);}
 }
 const options={...scopeOptions,enabled:false};const api=createManualStageRevision(db,options);options.enabled=true;
 await assert.rejects(api.enroll('snapshot'),/disabled/);
});
test('schema composition only accepts exact pinned guard and refuses drift/double composition',async()=>{
 const schema=await readFile(new URL('./erp-handoff.schema.sql',import.meta.url),'utf8');
 const composed=composeManualRevisionHandoffSchema(schema);
 assert.match(composed,/manual_revision_conflict/);
 assert.throws(()=>composeManualRevisionHandoffSchema(composed),/unverified/);
 assert.throws(()=>composeManualRevisionHandoffSchema(schema.replace("RAISE(IGNORE)","RAISE(ABORT,'changed')")),/unverified/);
 assert.ok(composed.indexOf('manual_revision_conflict')<composed.indexOf('RAISE(IGNORE)'));
});
describe('local manual revision on pinned actual native D1',{skip:!process.env.MINIFLARE_MODULE},()=>{
 let mf,db,api,outbound=0;
 const run=(sql,...args)=>db.prepare(sql).bind(...args).run();
 const put=(id,value='A',at=17)=>run('INSERT INTO crm_sync_state VALUES (?,?,?)',`manual_stage:${id}`,value,at);
 const change=(id,value,at=17)=>run('UPDATE crm_sync_state SET value=?,updated_at=? WHERE key=?',value,at,`manual_stage:${id}`);
 const del=id=>run('DELETE FROM crm_sync_state WHERE key=?',`manual_stage:${id}`);
 const observe=id=>api.observe(id);
 const rev=async id=>(await observe(id)).revision;
 const rows=table=>db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all().then(r=>r.results);
 before(async()=>{
  const {Miniflare,Log,LogLevel}=await import(pathToFileURL(process.env.MINIFLARE_MODULE));
  mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("fixture only")}}',compatibilityDate:'2026-07-30',host:'127.0.0.1',port:0,cf:false,d1Databases:{DB:'synthetic-manual-revision'},d1Persist:false,log:new Log(LogLevel.NONE),outboundService:()=>{outbound++;return new Response('disabled',{status:403});}});
  db=await mf.getD1Database('DB');api=createManualStageRevision(db,scopeOptions);
  const manifest=JSON.parse(await readFile(new URL('./erp-handoff-fixtures/manifest.json',import.meta.url),'utf8'));
  assert.equal(manifest.commit,'16149d51389cbc4d625bbc8e26d766890e232c14');
  for(const file of ['erp-handoff-fixtures/handoff-schema.sql','erp-handoff.schema.sql','manual-stage-revision.schema.sql','manual-stage-revision.handoff.schema.sql']){
   let sql=await readFile(new URL(file,import.meta.url),'utf8');
   if(file==='erp-handoff.schema.sql')sql=composeManualRevisionHandoffSchema(sql);
   if(file.includes('fixtures'))assert.equal(createHash('sha256').update(sql).digest('hex'),manifest['handoff-schema'].sha256);
   await db.batch(sql.replace(/^\s*--.*$/gm,'').split(/(?=^(?:CREATE|ALTER|PRAGMA)\b)/m).map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
  }
  assert.equal((await db.prepare('PRAGMA recursive_triggers').first()).recursive_triggers,0);
 });
 after(async()=>{if(mf)await mf.dispose();});
 test('baseline observes current state only, missing state explicit, enrollment changes no UGC fields',async()=>{
  await put('base','past',1);await change('base','A',17);
  const before=await rows('crm_sync_state');
  assert.deepEqual(await api.enroll('base'),{creatorId:'base',revision:0,present:true,rawValue:'A',rawUpdatedAt:17});
  assert.deepEqual(await api.enroll('absent'),{creatorId:'absent',revision:0,present:false,rawValue:null,rawUpdatedAt:null});
  assert.deepEqual(await rows('crm_sync_state'),before);
  await assert.rejects(observe('not-enrolled'),/missing_or_uncertain/);
  await put('unrelated');await run("INSERT INTO crm_sync_state VALUES ('another:key','x',1)");
  assert.equal((await rows('pilot_manual_stage_observation')).length,2);
 });
 test('raw-value and timestamp ABA each advance twice, whitespace is not normalized',async()=>{
  await put('aba');await api.enroll('aba');await change('aba','B');await change('aba','A');assert.equal(await rev('aba'),2);
  await change('aba','A',18);await change('aba','A',17);assert.equal(await rev('aba'),4);
  await change('aba',' A');await change('aba','A');assert.equal(await rev('aba'),6);
 });
 test('delete/recreate and byte-identical INSERT OR REPLACE are observed with recursive triggers off',async()=>{
  await put('replace');await api.enroll('replace');await del('replace');assert.equal((await observe('replace')).present,false);await put('replace');assert.equal(await rev('replace'),2);
  await run("INSERT OR REPLACE INTO crm_sync_state VALUES ('manual_stage:replace','A',17)");assert.equal(await rev('replace'),3);
  await run("REPLACE INTO crm_sync_state VALUES ('manual_stage:replace','B',18)");assert.equal(await rev('replace'),4);
  await run("REPLACE INTO crm_sync_state VALUES ('manual_stage:replace','A',17)");assert.equal(await rev('replace'),5);
 });
 test('same UPDATE, ignored insert, DO NOTHING, false UPSERT WHERE and missing DELETE produce no events',async()=>{
  await put('noop');await api.enroll('noop');await change('noop','A');
  for(const sql of ["INSERT OR IGNORE INTO crm_sync_state VALUES ('manual_stage:noop','B',18)","INSERT INTO crm_sync_state VALUES ('manual_stage:noop','B',18) ON CONFLICT(key) DO NOTHING","INSERT INTO crm_sync_state VALUES ('manual_stage:noop','B',18) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE 0","INSERT INTO crm_sync_state VALUES ('manual_stage:noop','A',17) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at"])await run(sql);
  await del('absent');assert.equal(await rev('noop'),0);assert.equal(await rev('absent'),0);
  await assert.rejects(put('noop','B'),/UNIQUE/);await assert.rejects(run("INSERT OR REPLACE INTO crm_sync_state VALUES ('manual_stage:noop',NULL,17)"),/NOT NULL/);
  assert.equal(await rev('noop'),0);
 });
 test('UPSERT updates advance exactly once, not for the attempted INSERT',async()=>{
  await put('upsert');await api.enroll('upsert');
  await run("INSERT INTO crm_sync_state VALUES ('manual_stage:upsert','B',18) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at");assert.equal(await rev('upsert'),1);
  await run("INSERT INTO crm_sync_state VALUES ('manual_stage:upsert','A',17) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at");assert.equal(await rev('upsert'),2);
 });
 test('key moves and implicit REPLACE deletion of another enrolled row are observed',async()=>{
  await put('move-a');await api.enroll('move-a');await api.enroll('move-b');
  await run("UPDATE crm_sync_state SET key='manual_stage:move-b' WHERE key='manual_stage:move-a'");assert.equal(await rev('move-a'),1);assert.equal(await rev('move-b'),1);
  await put('rowid-a');await api.enroll('rowid-a');await api.enroll('rowid-b');
  const {rowid}=await db.prepare("SELECT rowid FROM crm_sync_state WHERE key='manual_stage:rowid-a'").first();
  await run("INSERT OR REPLACE INTO crm_sync_state(rowid,key,value,updated_at) VALUES (?,'manual_stage:rowid-b','A',17)",rowid);
  assert.equal(await rev('rowid-a'),1);assert.equal(await rev('rowid-b'),1);
 });
 test('UPDATE OR REPLACE identical target is a new incarnation even with recursive triggers off',async()=>{
  await put('update-replace');await run("INSERT INTO crm_sync_state VALUES ('untracked-replacement','A',17)");await api.enroll('update-replace');
  await run("UPDATE OR REPLACE crm_sync_state SET key='manual_stage:update-replace' WHERE key='untracked-replacement'");assert.equal(await rev('update-replace'),1);
  await run("UPDATE crm_sync_state SET rowid=rowid+1000 WHERE key='manual_stage:update-replace'");assert.equal(await rev('update-replace'),2);
 });
 test('default off and exact scope fail closed without taking over an existing enrollment',async()=>{
  await assert.rejects(createManualStageRevision(db).enroll('default-off'),/disabled/);
  await assert.rejects(createManualStageRevision(db,{...scopeOptions,agent:'other'}).enroll('wrong-agent'),/invalid_manual_scope/);
  await assert.rejects(createManualStageRevision(db,{...scopeOptions,agent:'diana-helios'}).enroll('base'),/uncertain_reconcile_same_creator/);
  assert.equal(await rev('base'),0);
 });
 test('concurrent enroll retries cannot reset a baseline; concurrent writes are all counted',async()=>{
  await put('race');const baselines=await Promise.all(Array.from({length:8},()=>api.enroll('race')));assert.ok(baselines.every(r=>r.revision===0));
  await Promise.all(Array.from({length:8},()=>run("UPDATE crm_sync_state SET updated_at=updated_at+1 WHERE key='manual_stage:race'")));
  assert.equal(await rev('race'),8);assert.equal((await api.enroll('race')).revision,8);
  const real=createManualStageRevision({prepare:sql=>db.prepare(sql),async batch(statements){await db.batch(statements);throw Error('lost committed response');}},scopeOptions);
  await assert.rejects(real.enroll('lost-enroll'),/lost committed/);assert.equal((await api.enroll('lost-enroll')).revision,0);
 });
 test('transaction rollback restores both observation and manual state including enrollment',async()=>{
  await put('rollback');await api.enroll('rollback');const before=await observe('rollback');
  await assert.rejects(db.batch([db.prepare("UPDATE crm_sync_state SET value='B' WHERE key='manual_stage:rollback'"),db.prepare("INSERT INTO crm_sync_state VALUES ('manual_stage:rollback','bad',17)")]),/UNIQUE/);
  assert.deepEqual(await observe('rollback'),before);
  await assert.rejects(db.batch([db.prepare("INSERT INTO pilot_manual_stage_enrollment VALUES ('pilot-erp','angela','rolled-enroll')"),db.prepare("INSERT INTO crm_sync_state VALUES ('manual_stage:rollback','bad',17)")]),/UNIQUE/);
  await assert.rejects(observe('rolled-enroll'),/missing_or_uncertain/);
 });
 test('metadata reset cannot happen via deletion or REPLACE, even recursive triggers off',async()=>{
  await assert.rejects(run("DELETE FROM pilot_manual_stage_enrollment WHERE creator_id='aba'"),/immutable/);
  await assert.rejects(run("INSERT OR REPLACE INTO pilot_manual_stage_enrollment VALUES ('pilot-erp','angela','aba')"),/already_exists/);
  await assert.rejects(run("DELETE FROM pilot_manual_stage_observation WHERE creator_id='aba'"),/reset_forbidden/);
  await assert.rejects(run("INSERT OR REPLACE INTO pilot_manual_stage_observation VALUES ('aba',0,1,'A',17)"),/reset_forbidden/);
  await assert.rejects(run("UPDATE pilot_manual_stage_observation SET revision=0 WHERE creator_id='aba'"),/invalid/);
 });
 test('exhaustion fails closed even under OR IGNORE; unrelated writers and noops remain unchanged',async()=>{
  await put('exhausted');await api.enroll('exhausted');
  const {sql}=await db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='pilot_manual_observation_monotonic'").first();
  // Synthetic boundary seeding, atomically restore the exact guard before any
  // tested writer. Never an exported reset path or remote migration.
  await db.batch([db.prepare('DROP TRIGGER pilot_manual_observation_monotonic'),db.prepare("UPDATE pilot_manual_stage_observation SET revision=9007199254740991 WHERE creator_id='exhausted'"),db.prepare(sql)]);
  const before=await observe('exhausted');
  for(const statement of ["UPDATE OR IGNORE crm_sync_state SET value='B' WHERE key='manual_stage:exhausted'","INSERT OR REPLACE INTO crm_sync_state VALUES ('manual_stage:exhausted','A',17)","DELETE FROM crm_sync_state WHERE key='manual_stage:exhausted'"])
   await assert.rejects(run(statement),/manual_revision_exhausted_or_invalid/);
  assert.deepEqual(await observe('exhausted'),before);
  await change('exhausted','A');await put('untracked-at-exhaustion','not normalized',999);
  await run("INSERT OR IGNORE INTO crm_sync_state VALUES ('manual_stage:untracked-at-exhaustion','ignored',0)");
  assert.deepEqual(await db.prepare("SELECT value,updated_at FROM crm_sync_state WHERE key='manual_stage:untracked-at-exhaustion'").first(),{value:'not normalized',updated_at:999});
  assert.deepEqual(await observe('exhausted'),before);
 });
 async function seedHandoff(id){
  const creator=`creator-${id}`,scope={namespace:'pilot-erp',agent:'angela',spreadsheetId:'synthetic-sheet',tabId:0,caseId:id};
  const input={...scope,sourceKey:handoffSourceKey(scope),checkpoint:'cp1',identityVersion:'id1',decisionVersion:'decision1',manualStage:'refused',responseRef:'synthetic-response',discussionRef:'synthetic-substantive-discussion'};
  await run('INSERT INTO ugc_creators(id,normalized_handle,lifecycle_stage,notes,created_at,updated_at) VALUES (?,?,?,?,?,?)',creator,id,'refused','untouched human notes',1,1);
  await run("INSERT INTO ugc_creator_platforms(id,creator_id,platform,handle,normalized_handle,created_at,updated_at) VALUES (?,?,'instagram',?,?,1,1)",`profile-${id}`,creator,id,id);
  await put(creator,JSON.stringify({from:'',to:'refused',by:'human',at:17}),17);const pin=await api.enroll(creator);
  await run("INSERT INTO pilot_erp_source VALUES (?,?,?,?,?,'existing',?,?,?, ?,?,'[]',100,'instagram','complete','current','settled',?,?,'substantive')",input.sourceKey,canonicalHandoffRequest(input),creator,`profile-${id}`,`collab-${id}`,id,'refused',pin.rawValue,pin.rawUpdatedAt,id,input.responseRef,input.discussionRef);
  await run('INSERT INTO pilot_manual_handoff_checkpoint VALUES (?,?,?)',input.sourceKey,creator,pin.revision);return {input,pin,creator};
 }
 const service=()=>createAtomicHandoffService({agent:'angela',config:{namespace:'pilot-erp',agents:{angela:'shadow','diana-helios':'off'}},db:createErpHandoffPersistence(db),verifyTrustedSource:async v=>v.sourceKey});
 test('actual handoff supplement rejects stale ABA while old raw CAS would pass; explicit fresh pin succeeds',async()=>{
  const {input,pin,creator}=await seedHandoff('handoffaba');await change(creator,'temporary');await change(creator,pin.rawValue,pin.rawUpdatedAt);
  await assert.rejects(service().transfer(input),/manual_revision_conflict/);
  assert.equal(await db.prepare('SELECT * FROM pilot_erp_handoffs WHERE source_key=?').bind(input.sourceKey).first(),null);
  await run('UPDATE pilot_manual_handoff_checkpoint SET revision=? WHERE source_key=?',(await observe(creator)).revision,input.sourceKey);
  const before=await rows('ugc_creators');await service().transfer(input);await service().transfer(input);assert.deepEqual(await rows('ugc_creators'),before);
  await del(creator);await put(creator,pin.rawValue,pin.rawUpdatedAt);await assert.rejects(service().transfer(input),/manual_revision_conflict/);
 });
 test('recreated/reordered composed guard cannot skip revision CAS on exact replay',async()=>{
  const {input,pin,creator}=await seedHandoff('reorder');await service().transfer(input);
  const {sql}=await db.prepare("SELECT sql FROM sqlite_master WHERE name='pilot_erp_handoff_guard'").first();
  assert.ok(sql.indexOf('manual_revision_conflict')<sql.indexOf('RAISE(IGNORE)'));
  await run('DROP TRIGGER pilot_erp_handoff_guard');
  await run("CREATE TRIGGER fixture_other_before BEFORE INSERT ON pilot_erp_handoffs BEGIN SELECT 1; END");
  await run(sql);
  await change(creator,'temporary');await change(creator,pin.rawValue,pin.rawUpdatedAt);
  await assert.rejects(service().transfer(input),/manual_revision_conflict/);
  await run('DROP TRIGGER fixture_other_before');
  await run("CREATE TRIGGER fixture_other_before BEFORE INSERT ON pilot_erp_handoffs BEGIN SELECT 1; END");
  await assert.rejects(service().transfer(input),/manual_revision_conflict/);
  assert.equal((await db.prepare('SELECT count(*) n FROM pilot_erp_handoffs WHERE source_key=?').bind(input.sourceKey).first()).n,1);
 });
 test('native actual handoff failure rolls back manual mutation, revision and handoff together',async()=>{
  const {input,creator}=await seedHandoff('handoffrollback');const before=await observe(creator);
  // Synthetic downstream mutation demonstrates that observers participate in the
  // same actual handoff transaction, even when work fails after the gate passed.
  await run(`CREATE TRIGGER fixture_manual_late_failure BEFORE INSERT ON ugc_collaborations WHEN NEW.id='collab-handoffrollback' BEGIN
   UPDATE crm_sync_state SET value='transient' WHERE key='manual_stage:creator-handoffrollback';
   SELECT RAISE(ABORT,'fixture_manual_late_failure'); END`);
  await assert.rejects(service().transfer(input),/fixture_manual_late_failure/);assert.deepEqual(await observe(creator),before);
  assert.equal(await db.prepare('SELECT * FROM pilot_erp_handoffs WHERE source_key=?').bind(input.sourceKey).first(),null);
  assert.equal(outbound,0);
 });
});
