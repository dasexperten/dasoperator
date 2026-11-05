/** Detached NONPRODUCTION D1 service. No route mounts, credentials or source writer. */
import {PILOT_AGENTS,pilotMode} from './store.mjs';
const keys=['namespace','agent','spreadsheetId','tabId','caseId','sourceKey','checkpoint','identityVersion','decisionVersion','manualStage','responseRef','discussionRef'];
const fail=code=>{throw new Error(code);};
function exact(value,allowed,required=allowed) {
 if(!value||Object.getPrototypeOf(value)!==Object.prototype||Reflect.ownKeys(value).some(k=>!allowed.includes(k))||required.some(k=>!Object.hasOwn(value,k))||Object.values(Object.getOwnPropertyDescriptors(value)).some(d=>!d.enumerable||!Object.hasOwn(d,'value')))fail('invalid_request_fields');
}
export function handoffSourceKey({namespace,agent,spreadsheetId,tabId,caseId}) {return JSON.stringify([namespace,agent,spreadsheetId,tabId,caseId]);}
export function canonicalHandoffRequest(value) {
 exact(value,keys);
 for(const k of keys.filter(k=>k!=='tabId')) if(typeof value[k]!=='string'||value[k].length>(k==='sourceKey'?4096:1024)||(!value[k]&&k!=='manualStage')||!value[k].isWellFormed()||/[\x00-\x1f\x7f]/.test(value[k]))fail('invalid_request_value');
 if(!Number.isSafeInteger(value.tabId)||value.tabId<0||!PILOT_AGENTS.includes(value.agent)||!/^pilot-[a-z0-9][a-z0-9-]{0,47}$/.test(value.namespace)||value.sourceKey!==handoffSourceKey(value))fail('invalid_source_scope');
 return JSON.stringify(Object.fromEntries(keys.map(k=>[k,value[k]])));
}
function settings(options) {
 exact(options,['agent','config','db','verifyTrustedSource','timeoutMs'],[]);
 const {agent,db,verifyTrustedSource}=options;
 if(agent!==undefined&&!PILOT_AGENTS.includes(agent))fail('invalid_agent');
 if(options.config!==undefined&&options.config!==null) {exact(options.config,['namespace','agents']);exact(options.config.agents,PILOT_AGENTS,[]);}
 const config=options.config==null?options.config:structuredClone(options.config);
 const modes=PILOT_AGENTS.map(a=>pilotMode(config,a));
 if(agent===undefined&&modes.includes('shadow'))fail('agent_required');
 const timeoutMs=Object.hasOwn(options,'timeoutMs')?options.timeoutMs:5000;
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>5000)fail('invalid_timeout');
 return {agent,config,db,verifyTrustedSource,timeoutMs,enabled:agent!==undefined&&pilotMode(config,agent)==='shadow'};
}
async function bounded(invoke,deadline) {
 const remaining=deadline-Date.now();if(remaining<=0)fail('deadline_exceeded');
 let timer;try {return await Promise.race([Promise.resolve().then(()=>{if(Date.now()>=deadline)fail('deadline_exceeded');return invoke();}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('deadline_exceeded')),remaining);})]);}finally{clearTimeout(timer);}
}
function build(options) {
 const pin=settings(options);
 const readiness=()=>!pin.enabled?'handoff_disabled':typeof pin.verifyTrustedSource!=='function'?'trusted_integration_missing':null;
 async function transfer(input,context,deadline=Date.now()+pin.timeoutMs) {
  const blocked=readiness();if(blocked)fail(blocked);
  const json=canonicalHandoffRequest(input),request=Object.freeze(JSON.parse(json));
  if(request.agent!==pin.agent||request.namespace!==pin.config.namespace)fail('source_scope_mismatch');
  // The required trusted verifier has NO production implementation. It must
  // authenticate the existing workflow and coherent evidence/source projection.
  const authorized=await bounded(()=>pin.verifyTrustedSource(request,context),deadline);
  if(authorized!==request.sourceKey)fail('trusted_verification_failed');
  // A timed-out verifier never resumes here. Recheck time immediately before
  // dispatch; a dispatched DB timeout remains an uncertain outcome, not failure.
  const result=await bounded(()=>pin.db.batch([
   pin.db.prepare(`INSERT INTO atomic_handoffs(source_key,request_json,creator_id,profile_id,collaboration_id)
    SELECT ?,?,creator_id,profile_id,collaboration_id FROM atomic_source WHERE source_key=?
    ON CONFLICT(source_key) DO NOTHING`).bind(request.sourceKey,json,request.sourceKey),
   pin.db.prepare('SELECT h.source_key,h.request_json,h.creator_id,h.profile_id,h.collaboration_id FROM atomic_handoffs h JOIN atomic_source s ON s.source_key=h.source_key WHERE h.source_key=?').bind(request.sourceKey),
  ]),deadline);
  if(!Array.isArray(result)||result.length!==2||result.some(r=>!r||r.success!==true||!Array.isArray(r.results))||result[0].results.length!==0||result[1].results.length!==1)fail('uncertain_readback_reconcile_same_key');
  const row=result[1].results[0];
  exact(row,['source_key','request_json','creator_id','profile_id','collaboration_id']);
  if(row.source_key!==request.sourceKey||row.request_json!==json||['creator_id','profile_id','collaboration_id'].some(k=>typeof row[k]!=='string'||! /^[\x21-\x7e]{1,256}$/.test(row[k])))fail('uncertain_readback_reconcile_same_key');
  return Object.freeze({sourceKey:row.source_key,creatorId:row.creator_id,profileId:row.profile_id,collaborationId:row.collaboration_id,nonproduction:true});
 }
 return {pin,readiness,transfer};
}
export function createAtomicHandoffService(options={}) {
 const {transfer}=build(options);return Object.freeze({transfer:(input,context)=>transfer(input,context)});
}
export function createAtomicHandoffEndpoint(options={}) {
 const {pin,readiness,transfer}=build(options);
 return async(request,context)=>{
  const deadline=Date.now()+pin.timeoutMs;
  const blocked=readiness();if(blocked)return Response.json({error:blocked},{status:503});
  if(request.method!=='POST')return Response.json({error:'method_not_allowed'},{status:405});
  if(request.headers.get('content-type')!=='application/json')return Response.json({error:'json_required'},{status:415});
  let phase='body',reader;const cancel=()=>{try{Promise.resolve(reader?.cancel()).catch(()=>{});}catch{}};
  try {
   if(!request.body)fail('body_required');reader=request.body.getReader();let size=0;const chunks=[];
   while(true){const {done,value}=await bounded(()=>reader.read(),deadline);if(done)break;size+=value.byteLength;
    if(size>8192){cancel();return Response.json({error:'request_too_large'},{status:413});}chunks.push(value);}
   const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
   const input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));canonicalHandoffRequest(input);
   phase='transfer';return Response.json(await transfer(input,context,deadline));
  }catch{cancel();return Response.json(phase==='body'?{error:'invalid_or_timed_out_body'}:{error:'handoff_rejected_or_unknown',retry:'same_request_only'},{status:409});}
 };
}
