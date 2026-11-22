/** Disabled local SQLite bookkeeping. No transfer executor or authenticated decision verifier. */
import { DatabaseSync } from 'node:sqlite';
import { PILOT_AGENTS, pilotMode } from './store.mjs';
const fail = code => { throw Error(code); };
function exact(v, keys, optional = []) {
 if (!v || Object.getPrototypeOf(v)!==Object.prototype || Reflect.ownKeys(v).some(k=>!keys.includes(k))
  || keys.some(k=>!optional.includes(k)&&!Object.hasOwn(v,k))
  || Object.values(Object.getOwnPropertyDescriptors(v)).some(d=>!Object.hasOwn(d,'value')||!d.enumerable)) fail('invalid_shape');
}
function text(v) { if(typeof v!=='string'||!v||v.length>2048||!v.isWellFormed()||/[\x00-\x1f\x7f]/.test(v)) fail('invalid_identity'); }
function binding(v) {
 exact(v,['agent','spreadsheetId','tabId','caseId','threadId','checkpoint','manualStage','responseId']);
 if(!PILOT_AGENTS.includes(v.agent)) fail('unsupported_agent');
 if(!Number.isSafeInteger(v.tabId)||v.tabId<0) fail('invalid_tab');
 if(typeof v.manualStage!=='string'||v.manualStage.length>2048||!v.manualStage.isWellFormed()||/[\x00-\x1f\x7f]/.test(v.manualStage)) fail('invalid_manual_stage');
 for(const k of ['spreadsheetId','caseId','threadId','checkpoint','responseId']) text(v[k]);
 return JSON.stringify(['agent','spreadsheetId','tabId','caseId','threadId','checkpoint','manualStage','responseId'].map(k=>v[k]));
}
function reservation(v) {
 exact(v,['reservationId','binding','sourceAssertion','decisionAssertion']);text(v.reservationId);
 const b=binding(v.binding),s=v.sourceAssertion,d=v.decisionAssertion;
 exact(s,['state','doNotContact','purgeMarker','relationship','actionOutcome','responseId']);
 if(s.state!=='current'||s.doNotContact!==false||s.purgeMarker!==null||s.relationship!=='unmapped'||s.actionOutcome!=='settled') fail('candidate_ineligible');
 text(s.responseId);if(s.responseId!==v.binding.responseId) fail('response_binding_mismatch');
 exact(d,['kind','decisionId','reviewerId','decidedAt','provenanceReference','binding']);
 if(d.kind!=='substantive') fail('substantive_assertion_required');
 for(const k of ['decisionId','reviewerId','decidedAt','provenanceReference']) text(d[k]);
 if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(d.decidedAt)||!Number.isFinite(Date.parse(d.decidedAt))||new Date(d.decidedAt).toISOString()!==d.decidedAt) fail('invalid_decision_time');
 if(binding(d.binding)!==b) fail('decision_binding_mismatch');
 return {binding:b,assertion:JSON.stringify([s.state,s.doNotContact,s.purgeMarker,s.relationship,s.actionOutcome,s.responseId,d.kind,d.decisionId,d.reviewerId,d.decidedAt,d.provenanceReference,b])};
}
const caveat = {localBookkeepingOnly:true, provenance:'metadata_assertions_not_authenticated', integrationStatus:'unimplemented',cutoverReady:false,liveWrites:false,executionAuthorized:false};
export function createHandoffRecoveryJournal(options={}) {
 exact(options,['config','db'],['config','db']);
 const config=options.config==null?options.config:structuredClone(options.config),db=options.db;
 for(const agent of PILOT_AGENTS) pilotMode(config,agent);
 function guard(agent) {
  if(pilotMode(config,agent)!=='shadow') fail('pilot_disabled');
  if(!(db instanceof DatabaseSync)) fail('local_sqlite_required');
 }
 function get(agent,id) {return db.prepare('SELECT * FROM pilot_handoff_reservations WHERE namespace=? AND agent=? AND reservation_id=?').get(config.namespace,agent,id);}
 function observations(agent,id) {return db.prepare('SELECT * FROM pilot_handoff_observations WHERE namespace=? AND agent=? AND reservation_id=? ORDER BY sequence').all(config.namespace,agent,id);}
 function report(agent,id,replay) {
  const row=get(agent,id),events=observations(agent,id),last=events.at(-1);
  return {...caveat,actions:[],reservationId:id,binding:Object.fromEntries(['agent','spreadsheetId','tabId','caseId','threadId','checkpoint','manualStage','responseId'].map((k,i)=>[k,JSON.parse(row.binding_json)[i]])),manualStage:JSON.parse(row.binding_json)[6],
   status:last?.kind??'reserved_outcome_unresolved',sequence:last?.sequence??0,erpCaseId:last?.erp_case_id??null,
   fence:'irreversible_within_pilot',replay};
 }
 return Object.freeze({
  reserve(input) {
   const e=reservation(input),m=structuredClone(input),b=m.binding;guard(b.agent);
   const result=db.prepare('INSERT INTO pilot_handoff_reservations(namespace,agent,workbook,tab,case_id,reservation_id,binding_json,assertion_json) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING')
    .run(config.namespace,b.agent,b.spreadsheetId,b.tabId,b.caseId,m.reservationId,e.binding,e.assertion);
   const row=get(b.agent,m.reservationId);
   if(!row||row.binding_json!==e.binding||row.assertion_json!==e.assertion) fail('reservation_conflict');
   // A reservation is only a permanent local fence; even the first call cannot authorize ERP creation.
   return report(b.agent,m.reservationId,Number(result.changes)===0);
  },
  observe(input) {
   exact(input,['agent','reservationId','observationId','expectedSequence','kind','erpCaseId']);
   const m=structuredClone(input);guard(m.agent);text(m.reservationId);text(m.observationId);
   if(!Number.isSafeInteger(m.expectedSequence)||m.expectedSequence<0) fail('invalid_sequence');
   if(!['erp_unknown','erp_in_progress','erp_identified','sheet_ack_failed','sheet_acknowledged'].includes(m.kind)) fail('invalid_observation');
   if(['erp_unknown','erp_in_progress'].includes(m.kind)) {if(m.erpCaseId!==null) fail('invalid_erp_identity');} else text(m.erpCaseId);
   if(!get(m.agent,m.reservationId)) fail('reservation_missing');
   const prior=observations(m.agent,m.reservationId).find(r=>r.observation_id===m.observationId);
   if(prior) {
    if(prior.sequence!==m.expectedSequence+1||prior.kind!==m.kind||prior.erp_case_id!==m.erpCaseId) fail('observation_conflict');
    return report(m.agent,m.reservationId,true);
   }
   // Atomic INSERT + trigger checks establish sequence/identity consistency, even for stale writers.
   db.prepare('INSERT INTO pilot_handoff_observations(namespace,agent,reservation_id,sequence,observation_id,kind,erp_case_id) VALUES(?,?,?,?,?,?,?)')
    .run(config.namespace,m.agent,m.reservationId,m.expectedSequence+1,m.observationId,m.kind,m.erpCaseId);
   return report(m.agent,m.reservationId,false);
  },
  read(input) {
   exact(input,['agent','reservationId']);guard(input.agent);text(input.reservationId);
   if(!get(input.agent,input.reservationId)) fail('reservation_missing');
   return report(input.agent,input.reservationId,undefined);
  },
 });
}
