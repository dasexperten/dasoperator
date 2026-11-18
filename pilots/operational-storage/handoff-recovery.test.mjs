import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHandoffRecoveryJournal } from './handoff-recovery.mjs';
const config={namespace:'pilot-handoff-test',agents:{angela:'shadow','diana-helios':'shadow'}};
function fixture(t) {
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec(readFileSync(new URL('./handoff-recovery.schema.sql',import.meta.url),'utf8'));
 return {db,j:createHandoffRecoveryJournal({config,db}),other:createHandoffRecoveryJournal({config,db})};
}
function candidate(patch={}) {
 const binding={agent:'angela',spreadsheetId:'fixture-workbook',tabId:1,caseId:'fixture-stable-case',threadId:'fixture-thread',checkpoint:'fixture-checkpoint',manualStage:'manual-review',responseId:'fixture-reply',...patch};
 return {reservationId:'fixture-reservation',binding,sourceAssertion:{state:'current',doNotContact:false,purgeMarker:null,relationship:'unmapped',actionOutcome:'settled',responseId:binding.responseId},
 decisionAssertion:{kind:'substantive',decisionId:'fixture-decision',reviewerId:'fixture-reviewer',decidedAt:'2026-11-05T00:00:00.000Z',provenanceReference:'fixture-reference-not-authentication',binding:structuredClone(binding)}};
}
const observation=(sequence,kind='erp_unknown',erpCaseId=null,id=`observation-${sequence}`)=>({agent:'angela',reservationId:'fixture-reservation',observationId:id,expectedSequence:sequence,kind,erpCaseId});
const read={agent:'angela',reservationId:'fixture-reservation'};
test('disabled by default; only shadow and local SQLite; no actions or permission in reports',t=>{
 const {db,j}=fixture(t);
 for(const configOverride of [undefined,null,{...config,agents:{}},{...config,agents:{angela:'off'}}]) assert.throws(()=>createHandoffRecoveryJournal({config:configOverride,db}).reserve(candidate()),/pilot_disabled/);
 for(const configOverride of [{...config,namespace:'production'},{...config,agents:{angela:'primary'}},{...config,agents:{other:'shadow'}}]) assert.throws(()=>createHandoffRecoveryJournal({config:configOverride,db}));
 assert.throws(()=>createHandoffRecoveryJournal({config,db:{prepare(){throw Error('must not call');}}}).reserve(candidate()),/local_sqlite_required/);
 assert.throws(()=>createHandoffRecoveryJournal({config,db,execute(){}}),/invalid_shape/);
 const result=j.reserve(candidate());assert.equal(result.localBookkeepingOnly,true);assert.equal(result.provenance,'metadata_assertions_not_authenticated');
 for(const key of ['cutoverReady','liveWrites','executionAuthorized']) assert.equal(result[key],false);assert.deepEqual(result.actions,[]);
 assert.equal(result.manualStage,'manual-review');assert.equal(result.status,'reserved_outcome_unresolved');
});
test('response alone, historical/purged/DNC/ambiguous or unresolved candidates fail closed',t=>{
 const {db,j}=fixture(t);
 for(const patch of [{state:'historical'},{state:'purged'},{state:'unknown'},{state:'absent'},{doNotContact:true},{purgeMarker:'purged'},{relationship:'ambiguous'},{relationship:'mapped'},{relationship:'absent'},{actionOutcome:'unknown'},{actionOutcome:'in_progress'},{actionOutcome:'uncertain'}]) {
  const m=candidate();Object.assign(m.sourceAssertion,patch);assert.throws(()=>j.reserve(m),/candidate_ineligible/);
 }
 for(const decisionAssertion of [null,{...candidate().decisionAssertion,kind:'preliminary'}]) assert.throws(()=>j.reserve({...candidate(),decisionAssertion}));
 assert.throws(()=>j.reserve({...candidate(),approved:true}),/invalid_shape/);
 const m=candidate();m.decisionAssertion.binding.checkpoint='stale';assert.throws(()=>j.reserve(m),/decision_binding_mismatch/);
 m.decisionAssertion.binding.checkpoint=m.binding.checkpoint;m.sourceAssertion.responseId='other';assert.throws(()=>j.reserve(m),/response_binding_mismatch/);
 assert.equal(db.prepare('SELECT count(*) n FROM pilot_handoff_reservations').get().n,0);
});
test('independent workbook/tab/case and exact two-agent scopes; decision/manual-stage binding immutable',t=>{
 const {j,db}=fixture(t);j.reserve(candidate());
 for(const patch of [{agent:'diana-helios'},{spreadsheetId:'other-workbook'},{tabId:2},{caseId:'other-case'}]) {
  const m=candidate(patch);m.reservationId+=JSON.stringify(patch);j.reserve(m);
 }
 assert.equal(db.prepare('SELECT count(*) n FROM pilot_handoff_reservations').get().n,5);
 for(const patch of [{checkpoint:'new'},{manualStage:'agreed'},{threadId:'other'},{responseId:'other'}]) assert.throws(()=>j.reserve(candidate(patch)),/reservation_conflict/);
 for(const key of ['decisionId','reviewerId','provenanceReference']) {const m=candidate();m.decisionAssertion[key]='changed';assert.throws(()=>j.reserve(m),/reservation_conflict/);}
 assert.throws(()=>j.reserve(candidate({agent:'diana'})),/unsupported_agent/);
 assert.throws(()=>j.read({...read,agent:'diana-helios'}),/reservation_missing/);
});
test('concurrent contenders converge only on exact reservation; stale observation writers cannot overwrite',async t=>{
 const {j,other,db}=fixture(t);
 const results=await Promise.all(Array.from({length:12},(_,i)=>Promise.resolve().then(()=>(i%2?j:other).reserve(candidate()))));
 assert.equal(results.filter(r=>!r.replay).length,1);
 const contenders=await Promise.allSettled([j,other].map((writer,i)=>Promise.resolve().then(()=>writer.observe(observation(0,'erp_unknown',null,`competing-${i}`)))));
 assert.equal(contenders.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(contenders.filter(r=>r.status==='rejected').length,1);
 assert.equal(db.prepare('SELECT count(*) n FROM pilot_handoff_observations').get().n,1);
 assert.throws(()=>other.reserve({...candidate(),reservationId:'new-attempt'}),/reservation_conflict/);
 assert.equal(j.read(read).sequence,1);
});
test('lost reservation/observation responses recover only through exact replay; unknown never releases fence',t=>{
 const {j}=fixture(t),m=candidate();
 assert.throws(()=>{j.reserve(m);throw Error('lost response after commit');},/lost response/);
 assert.equal(j.reserve(m).replay,true);
 for(const [seq,kind] of [[0,'erp_unknown'],[1,'erp_in_progress']]) {
  const event=observation(seq,kind);
  assert.throws(()=>{j.observe(event);throw Error('lost response after commit');},/lost response/);
  assert.equal(j.observe(event).replay,true);
  assert.throws(()=>j.observe({...event,kind:kind==='erp_unknown'?'erp_in_progress':'erp_unknown'}),/observation_conflict/);
  assert.throws(()=>j.reserve({...m,reservationId:'retry-new-case'}),/reservation_conflict/);
 }
 assert.equal(j.read(read).erpCaseId,null);assert.equal(j.read(read).sequence,2);
});
test('ERP identity survives Sheet failure and reconciliation can record only that same opaque mapping',t=>{
 const {j}=fixture(t);j.reserve(candidate());
 assert.throws(()=>j.observe(observation(0,'sheet_ack_failed','opaque-id')),/erp_identity_required/);
 j.observe(observation(0,'erp_identified','opaque-id'));
 const failed=observation(1,'sheet_ack_failed','opaque-id');j.observe(failed);
 assert.equal(j.read(read).erpCaseId,'opaque-id');
 for(const [kind,id] of [['erp_unknown',null],['erp_in_progress',null],['erp_identified','opaque-id'],['erp_identified','new-id'],['sheet_acknowledged','new-id']]) assert.throws(()=>j.observe(observation(2,kind,id)),/erp_identity_immutable/);
 assert.throws(()=>j.reserve({...candidate(),reservationId:'retry-after-sheet-failure'}),/reservation_conflict/);
 j.observe(observation(2,'sheet_ack_failed','opaque-id'));const done=observation(3,'sheet_acknowledged','opaque-id');
 const report=j.observe(done);assert.equal(report.erpCaseId,'opaque-id');assert.equal(report.manualStage,'manual-review');
 assert.equal(j.observe(done).replay,true);assert.equal(j.observe(failed).status,'sheet_acknowledged');
 assert.throws(()=>j.observe(observation(4,'sheet_ack_failed','opaque-id')),/terminal_observation/);
});
test('SQLite independently rejects deletion, mutation, replacement, missing reservation and sequence gaps',t=>{
 const {j,db}=fixture(t);j.reserve(candidate());j.observe(observation(0));
 for(const table of ['pilot_handoff_reservations','pilot_handoff_observations']) {
  assert.throws(()=>db.exec(`DELETE FROM ${table}`),/immutable_handoff_fence|append_only_observation/);
  assert.throws(()=>db.exec(`UPDATE ${table} SET namespace='pilot-changed'`),/immutable_handoff_fence|append_only_observation/);
 }
 db.exec('PRAGMA recursive_triggers=OFF');
 db.exec('INSERT OR REPLACE INTO pilot_handoff_reservations SELECT * FROM pilot_handoff_reservations');
 assert.throws(()=>db.exec('INSERT OR REPLACE INTO pilot_handoff_observations SELECT * FROM pilot_handoff_observations'),/observation_conflict|stale_sequence/);
 const insert=db.prepare('INSERT INTO pilot_handoff_observations VALUES(?,?,?,?,?,?,?)');
 assert.throws(()=>insert.run(config.namespace,'angela','missing',1,'missing','erp_unknown',null),/reservation_missing/);
 assert.throws(()=>insert.run(config.namespace,'angela','fixture-reservation',8,'gap','erp_unknown',null),/stale_sequence/);
 assert.equal(j.read(read).sequence,1);
});
test('input getters, hidden properties, symbols, malformed identities and planner reports are rejected',t=>{
 const {j}=fixture(t);
 const getter=candidate();Object.defineProperty(getter,'reservationId',{get(){throw Error('getter invoked');},enumerable:true});assert.throws(()=>j.reserve(getter),/invalid_shape/);
 const symbol=candidate();symbol[Symbol('approved')]=true;assert.throws(()=>j.reserve(symbol),/invalid_shape/);
 const hidden=candidate();Object.defineProperty(hidden,'approved',{value:true});assert.throws(()=>j.reserve(hidden),/invalid_shape/);
 for(const patch of [{caseId:''},{caseId:'\ud800'},{spreadsheetId:'\n'},{tabId:-1},{tabId:1.1}]) assert.throws(()=>j.reserve(candidate(patch)));
 assert.throws(()=>j.reserve({status:'reviewed_transition_candidate',destination:'google-sheets',...candidate()}),/invalid_shape/);
});

test('empty manually supplied stage stays empty; mapped identities cannot be claimed by another source case',t=>{
 const {j}=fixture(t);const m=candidate({manualStage:''});j.reserve(m);j.observe(observation(0,'erp_identified','opaque-shared'));
 assert.equal(j.read(read).manualStage,'');assert.equal(j.read(read).binding.manualStage,'');
 const second=candidate({caseId:'other-case'});second.reservationId='other-reservation';j.reserve(second);
 assert.throws(()=>j.observe({...observation(0,'erp_identified','opaque-shared'),reservationId:'other-reservation'}),/UNIQUE constraint/);
 assert.equal(j.read({...read,reservationId:'other-reservation'}).erpCaseId,null);
});

test('direct SQL cannot identify or acknowledge a NULL ERP identity, or bypass single identification',t=>{
 const {j,db}=fixture(t);j.reserve(candidate());
 const insert=db.prepare('INSERT INTO pilot_handoff_observations VALUES(?,?,?,?,?,?,?)');
 const write=(sequence,id,kind,erp)=>insert.run(config.namespace,'angela','fixture-reservation',sequence,id,kind,erp);
 assert.throws(()=>write(1,'null-identification','erp_identified',null),/CHECK constraint/);
 assert.equal(j.read(read).sequence,0);assert.equal(j.read(read).erpCaseId,null);
 write(1,'real-identification','erp_identified','opaque-real');
 for(const kind of ['erp_identified','sheet_ack_failed','sheet_acknowledged']) {
  assert.throws(()=>write(2,`null-${kind}`,kind,null),/erp_identity_immutable|CHECK constraint/);
 }
 assert.throws(()=>write(2,'second-identification','erp_identified','opaque-other'),/erp_identity_immutable/);
 assert.throws(()=>write(2,'reidentify-same','erp_identified','opaque-real'),/erp_identity_immutable/);
 assert.equal(j.read(read).sequence,1);assert.equal(j.read(read).erpCaseId,'opaque-real');
 write(2,'ack-same','sheet_acknowledged','opaque-real');assert.equal(j.read(read).status,'sheet_acknowledged');
});
