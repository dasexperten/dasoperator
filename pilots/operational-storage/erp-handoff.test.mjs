import {test,describe,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createErpHandoffPersistence} from './erp-handoff-persistence.mjs';
import {createAtomicHandoffService,canonicalHandoffRequest,handoffSourceKey} from './atomic-handoff.mjs';
const handleOf=(prefix,id)=>`${prefix}_${id.replaceAll('-','_')}`;
const config={namespace:'pilot-erp',agents:{angela:'shadow','diana-helios':'off'}};
const input=(id,stage='')=>{const scope={namespace:'pilot-erp',agent:'angela',spreadsheetId:'synthetic-sheet',tabId:0,caseId:id};return {...scope,sourceKey:handoffSourceKey(scope),checkpoint:'cp1',identityVersion:'identity1',decisionVersion:'decision1',manualStage:stage,responseRef:'synthetic-reply',discussionRef:'synthetic-substantive-discussion'};};
test('adapter is not an alternate arbitrary SQL path; service remains default off',async()=>{
 const persistence=createErpHandoffPersistence({prepare(){throw Error('unexpected DB access');}});
 assert.throws(()=>persistence.prepare('DELETE FROM ugc_creators'),/unsupported/);
 await assert.rejects(persistence.batch([]),/invalid/);
 await assert.rejects(createAtomicHandoffService({db:persistence}).transfer(input('off')),/disabled/);
 await assert.rejects(createAtomicHandoffService({agent:'angela',config,db:persistence}).transfer(input('missing-verifier')),/integration_missing/);
});
describe('actual pinned UGC schema on isolated native D1',{skip:!process.env.MINIFLARE_MODULE},()=>{
 let db,mf,outbound=0;
 const run=(sql,...values)=>db.prepare(sql).bind(...values).run();
 const rows=(table)=>db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all().then(r=>r.results);
 const service=()=>createAtomicHandoffService({agent:'angela',config,db:createErpHandoffPersistence(db),verifyTrustedSource:async v=>v.sourceKey});
 const history=()=>db.prepare("SELECT json_group_array(json(record)) AS value FROM (SELECT json_object('id',id,'creator_platform_id',creator_platform_id,'platform',platform,'old_handle',old_handle,'new_handle',new_handle,'evidence',evidence,'changed_at',changed_at) AS record FROM ugc_handle_history ORDER BY id)").first().then(r=>r.value);
 const call=v=>mf.dispatchFetch('http://synthetic-erp.invalid/',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(v)});
 before(async()=>{
  const {Miniflare,Log,LogLevel}=await import(pathToFileURL(process.env.MINIFLARE_MODULE));
  mf=new Miniflare({modules:true,scriptPath:fileURLToPath(new URL('./erp-handoff.fixture-worker.mjs',import.meta.url)),modulesRoot:fileURLToPath(new URL('./',import.meta.url)),compatibilityDate:'2026-07-30',host:'127.0.0.1',port:0,cf:false,d1Databases:{DB:'synthetic-actual-ugc'},d1Persist:false,log:new Log(LogLevel.NONE),outboundService:()=>{outbound++;return new Response('disabled',{status:403});}});
  db=await mf.getD1Database('DB');
  const manifest=JSON.parse(await readFile(new URL('./erp-handoff-fixtures/manifest.json',import.meta.url),'utf8'));
  assert.equal(manifest.commit,'16149d51389cbc4d625bbc8e26d766890e232c14');
  for(const path of ['./erp-handoff-fixtures/handoff-schema.sql','./erp-handoff.schema.sql']){
   const schema=await readFile(new URL(path,import.meta.url),'utf8');
   if(path.includes('fixtures'))assert.equal(createHash('sha256').update(schema).digest('hex'),manifest['handoff-schema'].sha256);
   const statements=schema.replace(/^\s*--.*$/gm,'').split(/(?=^(?:CREATE|ALTER|PRAGMA)\b)/m).map(s=>s.trim()).filter(Boolean);
   await db.batch(statements.map(s=>db.prepare(s)));
  }
 });
 after(async()=>{if(mf)await mf.dispose();});
 async function seed(id,{mode='new',stage='',manual=false,rename=false}={}){
  const v=input(id,stage),creator=`creator-${id}`,profile=`profile-${id}`,collab=`collab-${id}`,handle=handleOf('current',id);
  const manualValue=manual?JSON.stringify({from:'',to:stage,by:'synthetic-human',at:17,reviewed_at:null}):null;
  if(mode==='existing'){
   await run('INSERT INTO ugc_creators(id,normalized_handle,lifecycle_stage,notes,origin,accepted_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',creator,handle,stage,'Preserve exact original notes','self',123,10,20);
   await run('INSERT INTO ugc_creator_platforms(id,creator_id,platform,handle,normalized_handle,availability_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',profile,creator,'instagram',handle,handle,'available',10,20);
   if(manual)await run('INSERT INTO crm_sync_state VALUES (?,?,?)',`manual_stage:${creator}`,manualValue,17);
   if(rename)await run('INSERT INTO ugc_handle_history VALUES (?,?,?,?,?,?,?)',`history-${id}`,profile,'instagram',handleOf('old',id),handle,'synthetic pinned rename','2026-11-05');
  }
  await run(`INSERT INTO pilot_erp_source(source_key,request_json,creator_id,profile_id,collaboration_id,mode,current_handle,lifecycle_stage,manual_value,manual_updated_at,source_handle,history_json,observed_at,platform,coverage,state,outcome,response_ref,discussion_ref,qualification)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,v.sourceKey,canonicalHandoffRequest(v),creator,profile,collab,mode,handle,stage,manualValue,manual?17:null,rename?handleOf('old',id):handle,await history(),100,'instagram','complete','current','settled',v.responseRef,v.discussionRef,'substantive');
  return v;
 }
 async function noCreation(id){for(const [table,key] of [['ugc_creators',`creator-${id}`],['ugc_creator_platforms',`profile-${id}`],['ugc_collaborations',`collab-${id}`]])assert.equal(await db.prepare(`SELECT id FROM ${table} WHERE id=?`).bind(key).first(),null);assert.equal(await db.prepare('SELECT source_key FROM pilot_erp_handoffs WHERE source_key=?').bind(input(id).sourceKey).first(),null);}
 test('actual schema columns/defaults/triggers match pinned source, no copied atomic tables',async()=>{
  const expected=JSON.parse(await readFile(new URL('./erp-handoff-fixtures/handoff-schema.shape.json',import.meta.url),'utf8'));
  for(const [table,shape] of Object.entries(expected)){
   const actual=(await db.prepare(`PRAGMA table_info(${table})`).all()).results.map(r=>({cid:r.cid,name:r.name,type:r.type,notnull:r.notnull,default:r.dflt_value,pk:r.pk}));assert.deepEqual(actual,shape.columns);
  }
  assert.equal((await db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'atomic_%'").first()).n,0);
  assert.equal((await db.prepare('PRAGMA foreign_keys').first()).foreign_keys,1);
 });
 test('new blank stage stays blank, replied collaboration uses real columns, concurrent replay stable',async()=>{
  const v=await seed('new');const responses=await Promise.all(Array.from({length:6},()=>call(v)));assert.ok(responses.every(r=>r.status===200));
  const results=await Promise.all(responses.map(r=>r.json()));assert.ok(results.every(r=>JSON.stringify(r)===JSON.stringify(results[0])));
  const c=await db.prepare("SELECT * FROM ugc_creators WHERE id='creator-new'").first();assert.equal(c.lifecycle_stage,'');assert.equal(c.accepted_at,null);assert.equal(c.notes,null);assert.equal(c.origin,null);
  const collaboration=await db.prepare("SELECT * FROM ugc_collaborations WHERE id='collab-new'").first();assert.equal(collaboration.status,'replied');assert.equal(collaboration.accepted_at,null);assert.equal(collaboration.notes,null);
  const fence=await db.prepare('SELECT * FROM pilot_erp_handoffs WHERE source_key=?').bind(v.sourceKey).first();assert.equal(JSON.parse(fence.request_json).responseRef,v.responseRef);
 });
 test('real rename history resolves actual IDs and preserves every creator/profile/manual field',async()=>{
  const v=await seed('renamed',{mode:'existing',stage:'refused',manual:true,rename:true});
  const before=await Promise.all(['ugc_creators','ugc_creator_platforms','crm_sync_state','ugc_handle_history'].map(rows));
  const result=await service().transfer(v);assert.equal(result.creatorId,'creator-renamed');assert.equal(result.profileId,'profile-renamed');
  assert.deepEqual(await Promise.all(['ugc_creators','ugc_creator_platforms','crm_sync_state','ugc_handle_history'].map(rows)),before);
 });
 test('actual manual JSON/timestamp, human stage and archival changes reject without mutations',async()=>{
  for(const [id,sql] of [['manual',"UPDATE crm_sync_state SET value='changed' WHERE key='manual_stage:creator-manual'"],['timestamp',"UPDATE crm_sync_state SET updated_at=18 WHERE key='manual_stage:creator-timestamp'"],['stage',"UPDATE ugc_creators SET lifecycle_stage='owner' WHERE id='creator-stage'"],['archive',"UPDATE ugc_creators SET archived_at=22 WHERE id='creator-archive'"],['availability',"UPDATE ugc_creator_platforms SET availability_status='unavailable' WHERE id='profile-availability'"]]){
   const v=await seed(id,{mode:'existing',stage:'refused',manual:true});await run(sql);const before=await rows('ugc_creators');
   assert.equal((await call(v)).status,409);assert.deepEqual(await rows('ugc_creators'),before);assert.equal(await db.prepare('SELECT * FROM ugc_collaborations WHERE id=?').bind(`collab-${id}`).first(),null);
  }
 });
 test('invalid or inconsistent stored manual decision cannot be authenticated by matching metadata',async()=>{
  for(const [id,value] of [['invalid-manual','not json'],['wrong-manual',JSON.stringify({to:'agreed',at:17})]]){
   const v=await seed(id,{mode:'existing',stage:'refused',manual:true});
   await run('UPDATE crm_sync_state SET value=? WHERE key=?',value,`manual_stage:creator-${id}`);
   await run('UPDATE pilot_erp_source SET manual_value=? WHERE source_key=?',value,v.sourceKey);
   await assert.rejects(service().transfer(v),/manual_state_conflict/);
   assert.equal(await db.prepare('SELECT * FROM ugc_collaborations WHERE id=?').bind(`collab-${id}`).first(),null);
  }
 });
 test('actual purge markers on current, old and intermediate alias handles block',async()=>{
  for(const kind of ['current','old','intermediate']){
   const id=`purge-${kind}`,v=await seed(id,{mode:'existing',rename:true});
   let handle=handleOf(kind==='old'?'old':'current',id);
   if(kind==='intermediate'){
    await run('UPDATE ugc_handle_history SET new_handle=? WHERE id=?',handleOf('middle',id),`history-${id}`);
    await run('INSERT INTO ugc_handle_history VALUES (?,?,?,?,?,?,?)',`history2-${id}`,`profile-${id}`,'instagram',handleOf('middle',id),handleOf('current',id),'synthetic edge','2026-11-05');
    await run('UPDATE pilot_erp_source SET history_json=? WHERE source_key=?',await history(),v.sourceKey);handle=handleOf('middle',id);
   }
   await run('INSERT INTO crm_sync_state VALUES (?,?,?)',`ugc_purged:instagram:${handle}`,'{"reason":"silent_7d"}',100);
   await assert.rejects(service().transfer(v),/purged_identity/);
  }
 });
 test('history checkpoint changes, cycles and competing aliases fail closed',async()=>{
  const v=await seed('history',{mode:'existing',rename:true});await run("UPDATE ugc_handle_history SET evidence='changed' WHERE id='history-history'");await assert.rejects(service().transfer(v),/history_checkpoint/);
  const cycle=await seed('cycle',{mode:'existing',rename:true});await run('INSERT INTO ugc_handle_history VALUES (?,?,?,?,?,?,?)','cycle-back','profile-cycle','instagram','current_cycle','old_cycle','synthetic','2026-11-05');await run('UPDATE pilot_erp_source SET history_json=? WHERE source_key=?',await history(),cycle.sourceKey);await assert.rejects(service().transfer(cycle),/alias_cycle/);
  const collision=await seed('collision',{mode:'existing',rename:true});await run('INSERT INTO ugc_creator_platforms(id,creator_id,platform,handle,normalized_handle,created_at,updated_at) VALUES (?,?,?,?,?,?,?)','competing-profile','creator-new','instagram','old_collision','old_collision',1,1);await assert.rejects(service().transfer(collision),/alias_ownership/);
 });
 test('actual late collaboration failure rolls back creator, profile and fence without touching source',async()=>{
  const v=await seed('rollback');
  await run("CREATE TRIGGER fixture_erp_late_abort BEFORE INSERT ON ugc_collaborations WHEN NEW.id='collab-rollback' BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM ugc_creators WHERE id=NEW.creator_id) OR NOT EXISTS(SELECT 1 FROM ugc_creator_platforms WHERE creator_id=NEW.creator_id) THEN RAISE(ABORT,'expected_insert_missing') END; SELECT RAISE(ABORT,'fixture_late_abort'); END");
  const before=await Promise.all(['ugc_creators','ugc_creator_platforms','ugc_collaborations','pilot_erp_handoffs','pilot_erp_source'].map(rows));
  await assert.rejects(service().transfer(v),/fixture_late_abort/);await noCreation('rollback');assert.deepEqual(await Promise.all(['ugc_creators','ugc_creator_platforms','ugc_collaborations','pilot_erp_handoffs','pilot_erp_source'].map(rows)),before);
 });
 test('lost committed response reads same actual IDs; uncertain source and changed input cannot create',async()=>{
  const v=await seed('lost');await call(v);const result=await service().transfer(v);assert.equal(result.creatorId,'creator-lost');
  await assert.rejects(service().transfer({...v,decisionVersion:'changed'}),/checkpoint/);
  await run("UPDATE pilot_erp_source SET outcome='unknown' WHERE source_key=?",v.sourceKey);await assert.rejects(service().transfer(v),/checkpoint/);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM ugc_creators WHERE id='creator-lost'").first()).n,1);
 });
 test('stale purge deletion batch rolls back entirely because actual IDs are FK-protected',async()=>{
  const v=await seed('stale-purge',{mode:'existing',rename:true});await service().transfer(v);
  const before=await Promise.all(['ugc_creators','ugc_creator_platforms','ugc_collaborations','ugc_handle_history','pilot_erp_handoffs','crm_sync_state'].map(rows));
  await assert.rejects(db.batch([
   db.prepare("INSERT INTO crm_sync_state VALUES ('ugc_purged:instagram:current_stale_purge','synthetic',100)"),
   db.prepare("DELETE FROM ugc_handle_history WHERE creator_platform_id='profile-stale-purge'"),
   db.prepare("DELETE FROM ugc_collaborations WHERE creator_id='creator-stale-purge'"),
   db.prepare("DELETE FROM ugc_creator_platforms WHERE creator_id='creator-stale-purge'"),
   db.prepare("DELETE FROM ugc_creators WHERE id='creator-stale-purge'"),
  ]),/FOREIGN KEY/i);
  assert.deepEqual(await Promise.all(['ugc_creators','ugc_creator_platforms','ugc_collaborations','ugc_handle_history','pilot_erp_handoffs','crm_sync_state'].map(rows)),before);
 });
 test('malformed/noncanonical source handles and case-variant actual aliases cannot bypass exclusions',async()=>{
  const v=await seed('bad-handle');
  for(const column of ['current_handle','source_handle'])for(const value of ['', 'Victim','bad-name','@name','bad\n','bad\u0000id','.start','end.','two..dots','x'.repeat(31)])
   await assert.rejects(run(`UPDATE pilot_erp_source SET ${column}=? WHERE source_key=?`,value,v.sourceKey),/constraint/i);
  await noCreation('bad-handle');
  for(const marker of ['ugc_purged:instagram:Victim','UGC_PURGED:instagram:victim']){
   await run("INSERT INTO crm_sync_state VALUES (?,'synthetic',1)",marker);
   await assert.rejects(service().transfer(v),/noncanonical_purge_marker/);
   await run('DELETE FROM crm_sync_state WHERE key=?',marker);
  }
  const alias=await seed('case-alias',{mode:'existing',rename:true});
  await run("UPDATE ugc_handle_history SET old_handle='Victim' WHERE id='history-case-alias'");
  await run("INSERT INTO crm_sync_state VALUES ('ugc_purged:instagram:victim','synthetic',1)");
  await run('UPDATE pilot_erp_source SET history_json=? WHERE source_key=?',await history(),alias.sourceKey);
  await assert.rejects(service().transfer(alias),/noncanonical_instagram_identity/);
  await run("UPDATE ugc_handle_history SET old_handle='old_case_alias' WHERE id='history-case-alias'");
  await run("UPDATE ugc_creator_platforms SET normalized_handle='Victim' WHERE id='profile-case-alias'");
  await assert.rejects(service().transfer(v),/noncanonical_instagram_identity/);
  await run("UPDATE ugc_creator_platforms SET normalized_handle='current_case_alias' WHERE id='profile-case-alias'");
 });
 test('history caps reject before snapshot construction or recursive graph evaluation',async()=>{
  const v=await seed('history-budget');
  try {
   await run(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<2001)
    INSERT INTO ugc_handle_history SELECT 'budget_'||x,'profile-new','instagram','h'||x,'h'||(x+1),'e','t' FROM n`);
   await assert.rejects(service().transfer(v),/history_row_budget_exceeded/);
  }finally{await run("DELETE FROM ugc_handle_history WHERE id LIKE 'budget_%'");}
  const edges=await seed('edge-budget',{mode:'existing'});
  try {
   await run(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<65)
    INSERT INTO ugc_handle_history SELECT 'budget_'||x,'profile-edge-budget','instagram','h'||x,'h'||(x+1),'e','t' FROM n`);
   await assert.rejects(service().transfer(edges),/history_row_budget_exceeded/);
  }finally{await run("DELETE FROM ugc_handle_history WHERE id LIKE 'budget_%'");}
  try {
   await run('INSERT INTO ugc_handle_history VALUES (?,?,?,?,?,?,?)','budget_text','profile-new','instagram','h1','h2','x'.repeat(4097),'t');
   await assert.rejects(service().transfer(v),/history_text_budget_exceeded/);
  }finally{await run("DELETE FROM ugc_handle_history WHERE id LIKE 'budget_%'");}
  try {
   await run(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<300)
    INSERT INTO ugc_handle_history SELECT 'budget_'||x,'profile-new','instagram','h'||x,'h'||(x+1),?,'t' FROM n`,'x'.repeat(4000));
   await assert.rejects(service().transfer(v),/history_text_budget_exceeded/);
  }finally{await run("DELETE FROM ugc_handle_history WHERE id LIKE 'budget_%'");}
  await noCreation('history-budget');
 });
 test('real-schema cross-source REPLACE preserves mapping, actual identity and collaboration',async()=>{
  const first=await seed('replace-first');await service().transfer(first);
  const second=await seed('replace-second');await run("UPDATE pilot_erp_source SET collaboration_id='collab-replace-first' WHERE source_key=?",second.sourceKey);
  assert.equal((await db.prepare('PRAGMA recursive_triggers').first()).recursive_triggers,0);
  const before=await Promise.all(['ugc_creators','ugc_creator_platforms','ugc_collaborations','pilot_erp_handoffs'].map(rows));
  await assert.rejects(run('INSERT OR REPLACE INTO pilot_erp_handoffs VALUES (?,?,?,?,?)',second.sourceKey,canonicalHandoffRequest(second),'creator-replace-second','profile-replace-second','collab-replace-first'),/cross_source_collaboration_conflict/);
  assert.deepEqual(await Promise.all(['ugc_creators','ugc_creator_platforms','ugc_collaborations','pilot_erp_handoffs'].map(rows)),before);
 });
 test('missing source and changed real collaboration after commit block rather than recreate',async()=>{
  const missing=await seed('missing-source');await service().transfer(missing);
  await run('DELETE FROM pilot_erp_source WHERE source_key=?',missing.sourceKey);
  await assert.rejects(service().transfer(missing),/readback/);
  const changed=await seed('changed-collab');await service().transfer(changed);
  await run("UPDATE ugc_collaborations SET status='agreed' WHERE id='collab-changed-collab'");
  await assert.rejects(service().transfer(changed),/collaboration_readback_conflict/);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM ugc_creators WHERE id IN ('creator-missing-source','creator-changed-collab')").first()).n,2);
 });
 test('deletion, DNC, coverage, qualification and unsupported platform remain fail closed',async()=>{
  for(const [id,column,value] of [['deleted','state','deleted'],['dnc','state','do_not_contact'],['coverage','coverage','unknown'],['withdrawn','qualification','withdrawn'],['platform','platform','tiktok']]){
   const v=await seed(id);await run(`UPDATE pilot_erp_source SET ${column}=? WHERE source_key=?`,value,v.sourceKey);assert.equal((await call(v)).status,409);await noCreation(id);
  }
  assert.equal(outbound,0);
 });
});
