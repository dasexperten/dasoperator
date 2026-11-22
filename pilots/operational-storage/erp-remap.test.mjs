import {composeRemappingHandoffSchema} from './erp-remap.compose.mjs';
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,webcrypto} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {mergeIntentStatements,resolveStoredHandoff,currentPurgeEligibilitySql,currentEligiblePurgeStatements} from './erp-remap.mjs';
import {composeManualRevisionHandoffSchema} from './manual-stage-revision.compose.mjs';
import {createManualStageRevision} from './manual-stage-revision.mjs';
import {createErpHandoffPersistence} from './erp-handoff-persistence.mjs';
import {createAtomicHandoffService,canonicalHandoffRequest,handoffSourceKey} from './atomic-handoff.mjs';
let db,mf,route,purge,outbound=0;
const read=p=>readFile(new URL(p,import.meta.url),'utf8');
const run=(s,...v)=>db.prepare(s).bind(...v).run();
const first=(s,...v)=>db.prepare(s).bind(...v).first();
const all=(s,...v)=>db.prepare(s).bind(...v).all().then(x=>x.results);
const hash=s=>createHash('sha1').update(`blob ${Buffer.byteLength(s)}\0`).update(s).digest('hex');
const service=()=>createAtomicHandoffService({agent:'angela',config:{namespace:'pilot-erp',agents:{angela:'shadow'}},db:createErpHandoffPersistence(db),verifyTrustedSource:async v=>v.sourceKey});
before(async()=>{
 const {Miniflare,Log,LogLevel}=await import(pathToFileURL(process.env.MINIFLARE_MODULE));
 mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("local fixture")}}',compatibilityDate:'2026-07-30',host:'127.0.0.1',port:0,cf:false,d1Databases:{DB:'synthetic-erp-remap'},d1Persist:false,log:new Log(LogLevel.NONE),outboundService:()=>{outbound++;return new Response('blocked',{status:403});}});
 db=await mf.getD1Database('DB');
 route=await read('./erp-handoff-fixtures/ugc-merge-pinned.ts');assert.equal(hash(route),'4b5d146e3dda20a6617189b20fd2b1780899768e');
 purge=await read('./erp-remap-fixtures/ugc-silent-purge-pinned.ts');assert.equal(hash(purge),'26c9f48329f25220ff1daf395f29ad536d695623');
 const ddl=await read('./erp-remap-fixtures/purge-schema.sql');
 const manifest=JSON.parse(await read('./erp-handoff-fixtures/manifest.json'));
 assert.equal(createHash('sha256').update(ddl).digest('hex'),manifest['purge-schema'].sha256);
 for(const schema of [ddl,composeRemappingHandoffSchema(composeManualRevisionHandoffSchema(await read('./erp-handoff.schema.sql'))),await read('./erp-remap.schema.sql'),await read('./manual-stage-revision.schema.sql'),await read('./manual-stage-revision.handoff.schema.sql')]){
  await db.batch(schema.replace(/^\s*--.*$/gm,'').split(/(?=^(?:CREATE|ALTER|PRAGMA)\b)/m).map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
 }
});
after(async()=>{assert.equal(outbound,0);await mf?.dispose();});
async function card(id,stage=''){
 await run('INSERT INTO ugc_creators(id,normalized_handle,lifecycle_stage,notes,origin,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',id,id,stage,`notes ${id}`,'self',1,2);
 await run('INSERT INTO ugc_creator_platforms(id,creator_id,platform,handle,normalized_handle,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',`p_${id}`,id,'instagram',id,id,1,2);
}
async function enroll(id){
 await card(id,'refused');
 const manual=JSON.stringify({from:'',to:'refused',by:'synthetic-human',at:17,reviewed_at:18});
 await run('INSERT INTO crm_sync_state VALUES (?,?,?)',`manual_stage:${id}`,manual,17);
 const scope={namespace:'pilot-erp',agent:'angela',spreadsheetId:'synthetic',tabId:0,caseId:id};
 const v={...scope,sourceKey:handoffSourceKey(scope),checkpoint:'cp1',identityVersion:'v1',decisionVersion:'v1',manualStage:'refused',responseRef:'synthetic-response',discussionRef:'synthetic-deliberate-discussion'};
 const history=await first("SELECT json_group_array(json(record)) value FROM (SELECT json_object('id',id,'creator_platform_id',creator_platform_id,'platform',platform,'old_handle',old_handle,'new_handle',new_handle,'evidence',evidence,'changed_at',changed_at) record FROM ugc_handle_history ORDER BY id)");
 await run(`INSERT INTO pilot_erp_source VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,v.sourceKey,canonicalHandoffRequest(v),id,`p_${id}`,`k_${id}`,'existing',id,'refused',manual,17,id,history.value,100,'instagram','complete','current','settled',v.responseRef,v.discussionRef,'substantive');
 const observed=await createManualStageRevision(db,{namespace:'pilot-erp',agent:'angela',enabled:true}).enroll(id);
 await run('INSERT INTO pilot_manual_handoff_checkpoint VALUES (?,?,?)',v.sourceKey,id,observed.revision);
 await service().transfer(v);return v;
}
async function mergeBatch(from,into,integrated=true){
 const profiles=await all('SELECT id, creator_id, platform, normalized_handle FROM ugc_creator_platforms WHERE creator_id IN (?1, ?2)',from,into);
 const oldProfiles=profiles.filter(p=>p.creator_id===from),target=profiles.find(p=>p.creator_id===into&&p.platform==='instagram');
 const oldIds=oldProfiles.map(p=>p.id),marks=oldIds.map((_,i)=>`?${i+2}`).join(',');
 const block=route.slice(route.indexOf('  const statements = [',route.indexOf("ugc.post('/creators/merge'")),route.indexOf('  try { await db.batch(statements);',route.indexOf("ugc.post('/creators/merge'")));
 const statements=new Function('db','crypto','into','target','from','oldProfiles','oldIds','marks','now',block+'return statements;')(db,webcrypto,into,target,from,oldProfiles,oldIds,marks,'2026-11-05');
 return integrated?mergeIntentStatements(db,{from,into,targetProfile:target.id},statements):statements;
}
function purgeBatch(id){
 const block=purge.slice(purge.indexOf('    statements.push('),purge.indexOf('\n  }\n  await env.DB.batch'));
 return new Function('env','row','now','PURGE_MARKER_PREFIX','const statements=[];'+block+'return statements;')({DB:db},{id,handle:id},100,'ugc_purged:instagram:');
}
const resolve=v=>resolveStoredHandoff(db,v.sourceKey,canonicalHandoffRequest(v));
test('alternative explicitly moves live FKs to mapping and preserves original schema file',async()=>{
 assert.equal((await all('PRAGMA foreign_key_list(pilot_erp_handoffs)')).length,0);
 assert.equal((await all('PRAGMA foreign_key_list(pilot_erp_case_mapping)')).length,3);
 assert.match(await read('./erp-handoff.schema.sql'),/FOREIGN KEY\(creator_id\) REFERENCES ugc_creators/);
});
test('exact merge SQL without intent fails atomically; integrated merge preserves human/child data and resolves survivor',async()=>{
 const v=await enroll('merge_old');await card('merge_live','owner');
 await run("INSERT INTO ugc_content(id,creator_id,creator_platform_id,imported_at,updated_at) VALUES ('content','merge_old','p_merge_old',1,2)");
 await run("INSERT INTO ugc_source_records(id,creator_id,creator_platform_id,kind,source_document,source_sheet,source_row,imported_at) VALUES ('source','merge_old','p_merge_old','product_reference','doc','sheet',7,1)");
 await run("INSERT INTO ugc_payouts(id,creator_id,creator_platform_id,amount_minor,payout_date,note,created_at,updated_at) VALUES ('payout','merge_old','p_merge_old',500,'2026-11-05','preserve payout',1,2)");
 await run("INSERT INTO ugc_payout_requisites(payout_id,fps_mobile_phone,first_name,created_at,updated_at) VALUES ('payout','synthetic-not-a-phone','Synthetic',1,2)");
 const childTables=['ugc_content','ugc_source_records','ugc_payouts','ugc_collaborations'];
 const childBefore=await Promise.all(childTables.map(t=>first(`SELECT * FROM ${t} WHERE creator_id='merge_old'`)));
 const requisites=await first("SELECT * FROM ugc_payout_requisites WHERE payout_id='payout'");
 const target=await first("SELECT * FROM ugc_creators WHERE id='merge_live'");
 const targetProfile=await first("SELECT * FROM ugc_creator_platforms WHERE id='p_merge_live'");
 const historicalFence=await first('SELECT * FROM pilot_erp_handoffs WHERE source_key=?',v.sourceKey);
 const sourceEvidence=await first('SELECT * FROM pilot_erp_source WHERE source_key=?',v.sourceKey);
 const before=await all('SELECT * FROM pilot_erp_case_mapping');
 await assert.rejects(db.batch(await mergeBatch('merge_old','merge_live',false)),/requires_intent/);
 assert.deepEqual(await all('SELECT * FROM pilot_erp_case_mapping'),before);
 assert.equal((await first("SELECT creator_id FROM ugc_payouts WHERE id='payout'")).creator_id,'merge_old');
 await db.batch(await mergeBatch('merge_old','merge_live'));
 assert.deepEqual(await resolve(v),{sourceKey:v.sourceKey,creatorId:'merge_live',profileId:'p_merge_live',collaborationId:'k_merge_old',mappingRevision:1,resolutionOnly:true});
 assert.deepEqual(await first("SELECT * FROM ugc_creators WHERE id='merge_live'"),target);
 assert.deepEqual(await first("SELECT * FROM ugc_creator_platforms WHERE id='p_merge_live'"),targetProfile);
 assert.deepEqual(await first('SELECT * FROM pilot_erp_handoffs WHERE source_key=?',v.sourceKey),historicalFence);
 assert.deepEqual(await first('SELECT * FROM pilot_erp_source WHERE source_key=?',v.sourceKey),sourceEvidence);
 for(const table of ['ugc_content','ugc_source_records','ugc_payouts']){const r=await first(`SELECT * FROM ${table} WHERE creator_id='merge_live'`);assert.equal(r.creator_platform_id,'p_merge_live');}
 assert.equal((await first("SELECT note FROM ugc_payouts WHERE id='payout'")).note,'preserve payout');
 for(let i=0;i<childTables.length;i++){const expected={...childBefore[i],creator_id:'merge_live'};if('creator_platform_id' in expected)expected.creator_platform_id='p_merge_live';assert.deepEqual(await first(`SELECT * FROM ${childTables[i]} WHERE id=?`,expected.id),expected);}
 assert.deepEqual(await first("SELECT * FROM ugc_payout_requisites WHERE payout_id='payout'"),requisites);
 const event=await first('SELECT * FROM pilot_erp_case_events WHERE source_key=? AND revision=1',v.sourceKey);
 assert.equal(JSON.parse(event.human_snapshot).notes,'notes merge_old');assert.equal(JSON.parse(event.human_snapshot).lifecycle_stage,'refused');
 assert.equal(JSON.parse(JSON.parse(event.human_snapshot).manual_value).reviewed_at,18);
 assert.equal((await first('SELECT creator_id FROM pilot_erp_handoffs WHERE source_key=?',v.sourceKey)).creator_id,'merge_old');
 assert.equal((await all('SELECT * FROM pilot_erp_mutation_intent')).length,0);
 await assert.rejects(service().transfer(v)); // original transfer never recreates historical IDs
 assert.equal(await first("SELECT * FROM ugc_creators WHERE id='merge_old'"),null);
});
test('exact marker-first stale purge after qualification fully rolls back',async()=>{
 const v=await enroll('stale');const before=await first("SELECT * FROM ugc_collaborations WHERE id='k_stale'");
 await assert.rejects(db.batch(purgeBatch('stale')),/requires_intent/);
 assert.deepEqual(await first("SELECT * FROM ugc_collaborations WHERE id='k_stale'"),before);
 assert.equal(await first("SELECT * FROM crm_sync_state WHERE key='ugc_purged:instagram:stale'"),null);
 assert.equal((await resolve(v)).creatorId,'stale');
});
test('explicit current-eligible purge integration tombstones and replay cannot resurrect',async()=>{
 const v=await enroll('delete_me');
 // Existing operator edits, not invented qualification status: only truly silent
 // current state may pass the exact purge selector. Intent alone is no authority.
 await run("UPDATE ugc_creators SET lifecycle_stage='silent' WHERE id='delete_me'");
 await run("UPDATE ugc_collaborations SET status='silent' WHERE id='k_delete_me'");
 const selector=purge.match(/const rows = await env.DB.prepare\(`([\s\S]*?)`\)\.bind/)[1];
 assert.equal(currentPurgeEligibilitySql,selector);
 await db.batch(currentEligiblePurgeStatements(db,{creatorId:'delete_me',now:2000000000},purgeBatch('delete_me')));
 await assert.rejects(resolve(v),/deleted_permanently/);await assert.rejects(service().transfer(v));
 assert.equal(await first("SELECT * FROM ugc_creators WHERE id='delete_me'"),null);
 const m=await first('SELECT * FROM pilot_erp_case_mapping WHERE source_key=?',v.sourceKey);assert.equal(m.state,'deleted');assert.equal(m.revision,1);
 assert.equal((await all('SELECT * FROM pilot_erp_case_events WHERE source_key=?',v.sourceKey)).length,2);
 await assert.rejects(run("DELETE FROM pilot_erp_handoffs WHERE source_key=?",v.sourceKey),/immutable/);
 await assert.rejects(run("INSERT OR REPLACE INTO pilot_erp_case_mapping VALUES (?,0,'active','stale','p_stale')",v.sourceKey),/permanent/);
});
test('intent cannot survive its transaction; stale eligibility cannot authorize mapped deletion',async()=>{
 await assert.rejects(run("INSERT INTO pilot_erp_mutation_intent(from_creator_id,kind,into_creator_id,into_profile_id) VALUES ('stale','merge','merge_live','p_merge_live')"),/FOREIGN KEY/i);
 assert.equal((await all('SELECT * FROM pilot_erp_mutation_intent')).length,0);
 const selector=purge.match(/const rows = await env.DB.prepare\(`([\s\S]*?)`\)\.bind/)[1];
 await assert.rejects(db.batch([db.prepare(`INSERT INTO pilot_erp_mutation_intent(from_creator_id,kind) SELECT id,'delete' FROM (${selector}) WHERE id=?3`).bind(1000000000,200,'stale'),...purgeBatch('stale'),db.prepare("DELETE FROM pilot_erp_mutation_intent WHERE from_creator_id='stale'")]),/requires_intent/);
});
test('original preexisting history FK blocker still rolls back integrated merge and intent',async()=>{
 const v=await enroll('history_old');await card('history_live');
 await run("INSERT INTO ugc_handle_history VALUES ('oldhistory','p_history_old','instagram','former','history_old','synthetic','2026-11-05')");
 await assert.rejects(db.batch(await mergeBatch('history_old','history_live')),/FOREIGN KEY/i);
 assert.equal((await resolve(v)).creatorId,'history_old');assert.equal((await all('SELECT * FROM pilot_erp_mutation_intent')).length,0);
 assert.equal((await all('SELECT * FROM pilot_erp_case_events WHERE source_key=?',v.sourceKey)).length,1);
});
test('unknown source outcome remains blocked after confirmed merge; unmapped purge unchanged',async()=>{
 await run("UPDATE pilot_erp_source SET outcome='unknown' WHERE creator_id='merge_old'");
 const h=await first("SELECT * FROM pilot_erp_handoffs WHERE creator_id='merge_old'");await assert.rejects(resolveStoredHandoff(db,h.source_key,h.request_json),/unresolved/);
 await card('unmapped');await db.batch(purgeBatch('unmapped'));assert.equal(await first("SELECT * FROM ugc_creators WHERE id='unmapped'"),null);
 await card('unmapped_old');await card('unmapped_live');await db.batch(await mergeBatch('unmapped_old','unmapped_live',false));
 assert.equal(await first("SELECT * FROM ugc_creators WHERE id='unmapped_old'"),null);assert.ok(await first("SELECT * FROM ugc_creators WHERE id='unmapped_live'"));
});

test('combined enrolled manual fence detects restored-value ABA and survives merge/delete history',async()=>{
 const v=await enroll('aba_combined');const original=await first("SELECT * FROM crm_sync_state WHERE key='manual_stage:aba_combined'");
 await run("UPDATE crm_sync_state SET value='changed' WHERE key='manual_stage:aba_combined'");
 await run("UPDATE crm_sync_state SET value=?,updated_at=? WHERE key='manual_stage:aba_combined'",original.value,original.updated_at);
 await assert.rejects(service().transfer(v),/manual_revision_conflict/);
 const observed=await createManualStageRevision(db,{namespace:'pilot-erp',agent:'angela',enabled:true}).observe('aba_combined');assert.equal(observed.revision,2);
 assert.equal((await resolve(v)).creatorId,'aba_combined'); // identity only, never fresh transfer approval
 for(const id of ['merge_old','delete_me'])assert.ok(await first('SELECT * FROM pilot_manual_stage_enrollment WHERE creator_id=?',id));
 const old=await first("SELECT * FROM crm_sync_state WHERE key='manual_stage:merge_old'");assert.equal(JSON.parse(old.value).to,'refused');
});
test('lost merge response reconciles same source mapping without repeating legacy destructive SQL',async()=>{
 const v=await enroll('lost_old');await card('lost_live');
 await db.batch(await mergeBatch('lost_old','lost_live')); // response deliberately discarded
 const firstRead=await resolve(v);const secondRead=await resolve(v);assert.deepEqual(firstRead,secondRead);assert.equal(firstRead.creatorId,'lost_live');
 assert.equal((await all('SELECT * FROM pilot_erp_case_events WHERE source_key=?',v.sourceKey)).length,2);
 assert.equal(await first("SELECT * FROM ugc_creators WHERE id='lost_old'"),null);
});

test('read-only reconciliation rejects malformed authoritative readback',async()=>{
 const base={source_key:'source',request_json:'request',collaboration_id:'collab',state:'active',revision:0,creator_id:'creator',profile_id:'profile',actual_creator:'creator',actual_profile_creator:'creator',actual_collaboration_creator:'creator',source_state:'current',outcome:'settled',coverage:'complete',qualification:'substantive'};
 for(const row of [{request_json:'request',source_state:'current',outcome:'settled',coverage:'complete',qualification:'substantive'},...Object.keys(base).map(k=>{const r={...base};delete r[k];return r;}),{...base,state:'unknown'},{...base,revision:NaN},{...base,revision:1.5},{...base,source_key:'different'},{...base,creator_id:''}]){
  const fake={prepare:()=>({bind:()=>({first:async()=>row})})};await assert.rejects(resolveStoredHandoff(fake,'source','request'));
 }
});

test('wrapped purge fails current eligibility for unmapped stale selection before marker or deletion',async()=>{
 await card('unmapped_stale');
 await run("UPDATE ugc_creators SET lifecycle_stage='owner' WHERE id='unmapped_stale'");
 const before=await first("SELECT * FROM ugc_creators WHERE id='unmapped_stale'");
 await assert.rejects(db.batch(currentEligiblePurgeStatements(db,{creatorId:'unmapped_stale',now:2000000000},purgeBatch('unmapped_stale'))),/current_purge_eligibility_missing/);
 assert.deepEqual(await first("SELECT * FROM ugc_creators WHERE id='unmapped_stale'"),before);
 assert.equal(await first("SELECT * FROM crm_sync_state WHERE key='ugc_purged:instagram:unmapped_stale'"),null);
});
test('fresh source keys cannot reuse retired IDs or known deleted handles',async()=>{
 const original=await first("SELECT * FROM pilot_erp_source WHERE creator_id='delete_me'");
 for(const [suffix,creator,profile,handle] of [['creator','delete_me','fresh_profile','brand_new'],['profile','fresh_creator','p_delete_me','brand_new'],['handle','fresh_creator','fresh_profile','delete_me'],['merged','merge_old','fresh_profile','brand_new']]){
  const scope={namespace:'pilot-erp',agent:'angela',spreadsheetId:'synthetic',tabId:0,caseId:'reuse_'+suffix};
  const v={...scope,sourceKey:handoffSourceKey(scope),checkpoint:'cp1',identityVersion:'v1',decisionVersion:'v1',manualStage:'',responseRef:'synthetic-response',discussionRef:'synthetic-deliberate-discussion'};
  await run(`INSERT INTO pilot_erp_source VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,v.sourceKey,canonicalHandoffRequest(v),creator,profile,'fresh_k_'+suffix,'new',handle,'',null,null,handle,original.history_json,100,'instagram','complete','current','settled',v.responseRef,v.discussionRef,'substantive');
  await run('DELETE FROM crm_sync_state WHERE key=?','manual_stage:'+creator);
  const observed=await createManualStageRevision(db,{namespace:'pilot-erp',agent:'angela',enabled:true}).enroll(creator);
  await run('INSERT INTO pilot_manual_handoff_checkpoint VALUES (?,?,?)',v.sourceKey,creator,observed.revision);
  const currentHistory=await first("SELECT json_group_array(json(record)) value FROM (SELECT json_object('id',id,'creator_platform_id',creator_platform_id,'platform',platform,'old_handle',old_handle,'new_handle',new_handle,'evidence',evidence,'changed_at',changed_at) record FROM ugc_handle_history ORDER BY id)");
  await run('UPDATE pilot_erp_source SET history_json=? WHERE source_key=?',currentHistory.value,v.sourceKey);
  await assert.rejects(service().transfer(v),/retired_handoff_identity|purged_identity/);
  assert.equal(await first('SELECT * FROM pilot_erp_handoffs WHERE source_key=?',v.sourceKey),null);
  assert.equal(await first('SELECT * FROM ugc_creators WHERE id=?',creator),null);
 }
});

test('exact purge retains known rename aliases before history deletion and rejects fresh-ID alias reuse',async()=>{
 const v=await enroll('renamed_deleted');
 await run("INSERT INTO ugc_handle_history VALUES ('retained_alias','p_renamed_deleted','instagram','historical_deleted','renamed_deleted','synthetic confirmed rename','2026-11-05')");
 const historyRow=await first("SELECT * FROM ugc_handle_history WHERE id='retained_alias'");
 await run("UPDATE ugc_creators SET lifecycle_stage='silent' WHERE id='renamed_deleted'");
 await run("UPDATE ugc_collaborations SET status='silent' WHERE id='k_renamed_deleted'");
 await run("CREATE TRIGGER fixture_alias_delete_abort BEFORE DELETE ON ugc_creators WHEN OLD.id='renamed_deleted' BEGIN SELECT RAISE(ABORT,'late_alias_delete_failure'); END");
 await assert.rejects(db.batch(currentEligiblePurgeStatements(db,{creatorId:'renamed_deleted',now:2000000000},purgeBatch('renamed_deleted'))),/late_alias_delete_failure/);
 assert.deepEqual(await first("SELECT * FROM ugc_handle_history WHERE id='retained_alias'"),historyRow);
 assert.equal(await first('SELECT * FROM pilot_erp_retired_aliases WHERE source_key=?',v.sourceKey),null);
 assert.equal(await first("SELECT * FROM crm_sync_state WHERE key='ugc_purged:instagram:renamed_deleted'"),null);
 assert.equal((await resolve(v)).creatorId,'renamed_deleted');
 await run('DROP TRIGGER fixture_alias_delete_abort');
 await db.batch(currentEligiblePurgeStatements(db,{creatorId:'renamed_deleted',now:2000000000},purgeBatch('renamed_deleted')));
 assert.equal(await first("SELECT * FROM ugc_handle_history WHERE id='retained_alias'"),null);
 const alias=await first('SELECT * FROM pilot_erp_retired_aliases WHERE source_key=?',v.sourceKey);assert.deepEqual(JSON.parse(alias.history_json),historyRow);assert.equal(alias.revision,1);
 const scope={namespace:'pilot-erp',agent:'angela',spreadsheetId:'synthetic',tabId:0,caseId:'fresh_historical_alias'};
 const fresh={...scope,sourceKey:handoffSourceKey(scope),checkpoint:'cp1',identityVersion:'v1',decisionVersion:'v1',manualStage:'',responseRef:'synthetic-response',discussionRef:'synthetic-deliberate-discussion'};
 const currentHistory=await first("SELECT json_group_array(json(record)) value FROM (SELECT json_object('id',id,'creator_platform_id',creator_platform_id,'platform',platform,'old_handle',old_handle,'new_handle',new_handle,'evidence',evidence,'changed_at',changed_at) record FROM ugc_handle_history ORDER BY id)");
 await run('INSERT INTO pilot_erp_source VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',fresh.sourceKey,canonicalHandoffRequest(fresh),'fresh_alias_creator','fresh_alias_profile','fresh_alias_collab','new','historical_deleted','',null,null,'historical_deleted',currentHistory.value,100,'instagram','complete','current','settled',fresh.responseRef,fresh.discussionRef,'substantive');
 const observed=await createManualStageRevision(db,{namespace:'pilot-erp',agent:'angela',enabled:true}).enroll('fresh_alias_creator');
 await run('INSERT INTO pilot_manual_handoff_checkpoint VALUES (?,?,?)',fresh.sourceKey,'fresh_alias_creator',observed.revision);
 assert.equal(await first("SELECT * FROM crm_sync_state WHERE key='ugc_purged:instagram:historical_deleted'"),null);
 await assert.rejects(service().transfer(fresh),/retired_handoff_identity/);
 assert.equal(await first("SELECT * FROM ugc_creators WHERE id='fresh_alias_creator'"),null);
 await assert.rejects(run('DELETE FROM pilot_erp_retired_aliases WHERE source_key=?',v.sourceKey),/immutable_retired_alias/);
});

test('retained exclusions reject exact replay after live-history ABA, including actual selected-profile aliases',async()=>{
 for(const throughProfile of [false,true]){
  const aid=throughProfile?'edge_replay_a':'replay_a',bid=throughProfile?'edge_replay_b':'replay_b',alias=throughProfile?'old_edge_replay':aid;
  const a=await enroll(aid);
  if(throughProfile){
   await run('INSERT INTO ugc_handle_history VALUES (?,?,?,?,?,?,?)','selected_profile_alias','p_'+aid,'instagram',alias,aid,'synthetic','2026-11-05');
   const history=await first("SELECT json_group_array(json(record)) value FROM (SELECT json_object('id',id,'creator_platform_id',creator_platform_id,'platform',platform,'old_handle',old_handle,'new_handle',new_handle,'evidence',evidence,'changed_at',changed_at) record FROM ugc_handle_history ORDER BY id)");
   await run('UPDATE pilot_erp_source SET history_json=? WHERE source_key=?',history.value,a.sourceKey);
   await service().transfer(a);
  }
  await enroll(bid);
  await run('INSERT INTO ugc_handle_history VALUES (?,?,?,?,?,?,?)','conflict_'+bid,'p_'+bid,'instagram',alias,bid,'synthetic','2026-11-05');
  await run("UPDATE ugc_creators SET lifecycle_stage='silent' WHERE id=?",bid);
  await run("UPDATE ugc_collaborations SET status='silent' WHERE id=?",'k_'+bid);
  await db.batch(currentEligiblePurgeStatements(db,{creatorId:bid,now:2000000000},purgeBatch(bid)));
  const currentHistory=await first("SELECT json_group_array(json(record)) value FROM (SELECT json_object('id',id,'creator_platform_id',creator_platform_id,'platform',platform,'old_handle',old_handle,'new_handle',new_handle,'evidence',evidence,'changed_at',changed_at) record FROM ugc_handle_history ORDER BY id)");
  assert.equal((await first('SELECT history_json FROM pilot_erp_source WHERE source_key=?',a.sourceKey)).history_json,currentHistory.value);
  await assert.rejects(service().transfer(a),/retired_handoff_identity/);
  assert.equal((await first('SELECT revision FROM pilot_erp_case_mapping WHERE source_key=?',a.sourceKey)).revision,0);
 }
});

test('noncanonical known history added after enrollment is retained verbatim and blocks fresh handoffs',async()=>{
 const v=await enroll('uncertain_alias');
 await run("INSERT INTO ugc_handle_history VALUES ('uncertain_history','p_uncertain_alias','instagram','Ambiguous','uncertain_alias','synthetic','2026-11-05')");
 await run("UPDATE ugc_creators SET lifecycle_stage='silent' WHERE id='uncertain_alias'");
 await run("UPDATE ugc_collaborations SET status='silent' WHERE id='k_uncertain_alias'");
 await db.batch(currentEligiblePurgeStatements(db,{creatorId:'uncertain_alias',now:2000000000},purgeBatch('uncertain_alias')));
 assert.equal((await first('SELECT * FROM pilot_erp_retired_aliases WHERE source_key=?',v.sourceKey)).old_handle,'Ambiguous');
 const old=await first("SELECT * FROM pilot_erp_handoffs WHERE creator_id='stale'");
 // Original exact replay can be rejected earlier for history changes; the dedicated
 // ABA fixture below proves retained checks run before replay IGNORE.
 await assert.rejects(run('INSERT INTO pilot_erp_handoffs VALUES (?,?,?,?,?)',old.source_key,old.request_json,old.creator_id,old.profile_id,old.collaboration_id));
});
