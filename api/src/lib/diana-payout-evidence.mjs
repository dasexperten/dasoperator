// Process-local capability. Not a network authorization mechanism.
const capabilities = new WeakMap();
const copy = value => JSON.parse(JSON.stringify(value));
function freeze(value){if(value&&typeof value==='object'){Object.freeze(value);for(const v of Object.values(value))freeze(v);}return value;}
async function digest(text){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(x=>x.toString(16).padStart(2,'0')).join('');}
export async function createDianaPayoutEvidence(resolve,identity){
 if(typeof resolve!=='function'||!identity?.conversation_id||!identity.event_id||!identity.source_key||!/^[a-f0-9]{64}$/.test(identity.sha256??''))throw Error('diana_evidence_identity_required');
 const request=freeze(copy(identity));
 // Resolver is a trusted server-side dependency; never supplied by HTTP body.
 const raw=await resolve(request);
 if(typeof raw!=='string'||await digest(raw)!==request.sha256)throw Error('diana_evidence_digest_mismatch');
 const data=JSON.parse(raw);
 if(data.complete_history!==true||data.version!==1||data.conversation_id!==request.conversation_id||data.event_id!==request.event_id||!Array.isArray(data.messages))throw Error('diana_evidence_identity_mismatch');
 if(request.payout_id&&(data.payout?.id!==request.payout_id||!data.notice_message_id||!['delivered','reviewed'].includes(data.notice_outcome)))throw Error('diana_evidence_payout_mismatch');
 const ids=new Set();
 for(const m of data.messages){if(!m?.id||ids.has(m.id)||m.conversation_id!==request.conversation_id||!['in','out'].includes(m.direction)||!Number.isFinite(Date.parse(m.created_at)))throw Error('diana_evidence_source_invalid');ids.add(m.id);}
 const token=Object.freeze({});capabilities.set(token,{identity:request,data:freeze(copy(data))});return token;
}
export function payoutEvidenceReader(env,cid,capability,eventId,cycleMessageId,payoutId){
 if(capability!==undefined){
  const item=capabilities.get(capability);
  if(!item||item.identity.conversation_id!==cid||(eventId&&item.identity.event_id!==eventId)||(cycleMessageId&&item.data.cycle_message_id!==cycleMessageId)||(payoutId&&item.identity.payout_id!==payoutId))throw Error('diana_evidence_capability_invalid');
  const s=item.data,byId=id=>s.messages.find(x=>x.id===id)??null;
  const latest=predicate=>({at:s.messages.filter(predicate).map(x=>x.created_at).sort((a,b)=>Date.parse(b)-Date.parse(a))[0]??null});
  const attached=m=>Array.isArray(m.attachments)&&m.attachments.length>0;
  return Object.freeze({provenance:()=>Object.freeze({mode:item.identity.source_key.startsWith('transient:')?'transient':'immutable_snapshot',source_sha256:item.identity.sha256}),reference:()=>Object.freeze({source_key:item.identity.source_key,sha256:item.identity.sha256}),noticePaymentIdentity:async()=>s.payout??null,source:async id=>byId(id),context:async()=>s.context?{value:JSON.stringify(s.context)}:null,cart:async()=>s.cart?{value:JSON.stringify(s.cart)}:null,
   latestImage:async()=>latest(m=>m.direction==='in'&&attached(m)),latestIncoming:async()=>latest(m=>m.direction==='in'),
   attachmentSource:async id=>{const m=byId(id);return m?.direction==='in'&&attached(m)?m:null;},
   notice:async(id,handle,reviewed)=>{if(item.identity.payout_id&&(id!==s.notice_message_id||(reviewed?'reviewed':'delivered')!==s.notice_outcome))return null;const m=byId(id);return m&&(reviewed||m.direction==='out')&&s.messages.some(x=>x.direction==='in'&&x.from_username?.toLowerCase()===handle)?m:null;}
  });
 }
 if(env.DIANA_EVIDENCE_MODE==='direct')throw Error('diana_evidence_capability_required');
 // Legacy is explicit only when no capability supplied; a forged/null one fails.
 const one=(sql,...args)=>env.DB.prepare(sql).bind(...args).first();
 return Object.freeze({
  noticePaymentIdentity:async()=>null,
  source:(id,withText=false)=>one('SELECT direction,from_username,created_at'+(withText?',text':'')+' FROM ugc_ig_messages WHERE id=?1 AND conversation_id=?2',id,cid),
  context:()=>one('SELECT value FROM crm_sync_state WHERE key=?1','diana_context:'+cid),
  cart:()=>one('SELECT value FROM crm_sync_state WHERE key=?1','ugc_cart_review:'+cid),
  latestImage:()=>one("SELECT MAX(created_at) at FROM ugc_ig_messages WHERE conversation_id=?1 AND direction='in' AND attachments_json IS NOT NULL AND attachments_json NOT IN ('[]','{}','null','') AND json_valid(attachments_json) AND json_type(attachments_json)='array' AND json_array_length(attachments_json)>0",cid),
  latestIncoming:()=>one("SELECT MAX(created_at) at FROM ugc_ig_messages WHERE conversation_id=?1 AND direction='in'",cid),
  attachmentSource:id=>one("SELECT created_at FROM ugc_ig_messages WHERE id=?1 AND conversation_id=?2 AND direction='in' AND json_valid(attachments_json) AND json_type(attachments_json)='array' AND json_array_length(attachments_json)>0",id,cid),
  notice:(id,handle,reviewed)=>one("SELECT id,created_at FROM ugc_ig_messages WHERE id=?1 AND conversation_id=?2 AND (?4=1 OR direction='out') AND EXISTS (SELECT 1 FROM ugc_ig_messages incoming WHERE incoming.conversation_id=?2 AND incoming.direction='in' AND LOWER(incoming.from_username)=?3)",id,cid,handle,reviewed?1:0)
 });
}
