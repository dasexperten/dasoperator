// Entire handoff runs inside one live workflow step. Never return source text,
// image bytes or financial account details from the step.
import {latestRequisites} from './ugc-latest-requisites.mjs';
import {konsolPhone,isFpsBankMemberId} from './ugc-payouts.mjs';
import {createDianaPayoutEvidence} from './diana-payout-evidence.mjs';
import {prepareCreatorPayout} from './ugc-payout-intake';
import {reviewPayoutCart} from './ugc-cart-review';
const BRAND=new Set(['1697038263872226','17841466350261166']);
const digest=async raw=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw)))].map(n=>n.toString(16).padStart(2,'0')).join('');
function normalize(source,event){
 if(source?.status!=='ready'||source.conversationId!==event.cid||source.messageId!==event.message_id||event.event_id!=='message:'+event.message_id||!Array.isArray(source.messages)||!source.messages.length||source.messages.length>5000)throw Error('payout_original_invalid');
 const seen=new Set(),now=Date.now(),latest=source.messages.at(-1),recipient=String(latest?.from?.id??'');
 if(!recipient||BRAND.has(recipient)||String(latest.id)!==event.message_id)throw Error('payout_original_changed');
 const handle=String(latest.from.username??event.handle??'').toLowerCase().replace(/^@/,'');if(!/^[a-z0-9_.]{1,40}$/.test(handle))throw Error('payout_handle_missing');
 let previousAt=-Infinity;
 const messages=source.messages.map(m=>{
  const id=String(m.id??''),sender=String(m.from?.id??''),at=Date.parse(m.created_time);
  if(!id||seen.has(id)||!sender||!Number.isFinite(at)||at<previousAt||at>now||(!BRAND.has(sender)&&sender!==recipient))throw Error('payout_source_identity_invalid');seen.add(id);previousAt=at;
  const attachments=Array.isArray(m.attachments?.data)?m.attachments.data:[];
  return{id,conversation_id:event.cid,direction:BRAND.has(sender)?'out':'in',from_id:sender,from_username:sender===recipient?handle:String(m.from.username??''),text:String(m.message??''),created_at:new Date(at).toISOString(),attachments,attachments_json:JSON.stringify(attachments),unsupported:m.is_unsupported===true};
 });
 return{messages,handle,recipient};
}
export async function handoffDirectPayout({env,event,source,refreshOriginal,infer,readImage,reviewCart=reviewPayoutCart,savePayout=prepareCreatorPayout}){
 if(event?.dryRun)return{status:'pending',reason:'payout_preview_no_write'};
 if(typeof refreshOriginal!=='function'||typeof infer!=='function')throw Error('payout_trusted_dependencies_required');
 const initial=normalize(source,event),r=latestRequisites(initial.messages);
 if(!r)return{status:'incomplete',missing_fields:['recipient_details'],reason:'payout_requisites_unconfirmed'};
 if(!konsolPhone(r.phone)||!isFpsBankMemberId(r.bank)||!String(r.first_name??'').trim())return{status:'incomplete',missing_fields:['recipient_details'],reason:'payout_requisites_unconfirmed'};
 // Unknown newer content could amend the same cycle. Never manufacture facts.
 const sourceTimes=r.source_message_ids.map(id=>Date.parse(initial.messages.find(m=>m.id===id)?.created_at??''));
 if(!sourceTimes.length||sourceTimes.some(at=>!Number.isFinite(at)))throw Error('payout_requisite_source_missing');
 const evidenceAt=Math.min(...sourceTimes);
 const unresolvedSince=at=>initial.messages.some(m=>m.direction==='in'&&Date.parse(m.created_at)>=at&&(m.unsupported||m.attachments.some(a=>a.video_data||String(a.mime_type??'').startsWith('video/'))));
 if(unresolvedSince(evidenceAt))return{status:'pending',reason:'payout_original_media_unresolved'};
 const cart=await reviewCart(env,event.cid,initial.messages,{transient:true,readOnly:true,infer,readImage,handle:initial.handle});
 if(cart?.status!=='confirmed'||!Number.isSafeInteger(cart.amount_minor)||cart.amount_minor<5000||cart.amount_minor>99900)return{status:'incomplete',missing_fields:['amount_minor'],reason:'payout_amount_unconfirmed'};
 const amountIds=[cart.source_message_id,cart.quote?.source_message_id].filter(Boolean);
 const amountTimes=amountIds.map(id=>Date.parse(initial.messages.find(m=>m.id===id)?.created_at??''));
 if(!amountTimes.length||amountTimes.some(at=>!Number.isFinite(at)))throw Error('payout_amount_source_missing');
 if(unresolvedSince(Math.min(evidenceAt,...amountTimes)))return{status:'pending',reason:'payout_original_media_unresolved'};
 // Full fresh read, not only matching last ID: catch edited older requisites/cart.
 const fresh=normalize(await refreshOriginal({conversationId:event.cid,messageId:event.message_id}),event);
 if(fresh.recipient!==initial.recipient||fresh.handle!==initial.handle||JSON.stringify(fresh.messages)!==JSON.stringify(initial.messages))return{status:'pending',reason:'payout_original_changed'};
 const existing=await env.DB.prepare("SELECT p.id,p.status,p.amount_minor,p.konsol_payment_id,p.execute_claim FROM ugc_payouts p JOIN ugc_creator_platforms cp ON cp.creator_id=p.creator_id WHERE cp.platform='instagram' AND cp.normalized_handle=?1 AND p.created_at>=?2 ORDER BY p.updated_at DESC LIMIT 1").bind(initial.handle,Date.now()-60*86400000).first();
 if(existing&&(existing.konsol_payment_id||existing.execute_claim||!['awaiting_approval','approved'].includes(existing.status)))return{status:'pending',reason:'payout_cycle_already_processed'};
 if(existing?.amount_minor>=5000&&existing.amount_minor!==cart.amount_minor)return{status:'pending',reason:'payout_existing_amount_conflict'};
 const raw=JSON.stringify({version:1,complete_history:true,conversation_id:event.cid,event_id:event.event_id,cycle_message_id:r.cycle_message_id,messages:fresh.messages,cart});
 const sha256=await digest(raw);
 // Resolver and hash are ephemeral in this process; never write raw to ERP/R2.
 const capability=await createDianaPayoutEvidence(async()=>raw,{conversation_id:event.cid,event_id:event.event_id,source_key:'transient:'+sha256,sha256});
 const result=await savePayout(env,{verified:true,handle:initial.handle,conversation_id:event.cid,cycle_message_id:r.cycle_message_id,source_message_ids:r.source_message_ids,amount_minor:cart.amount_minor,phone:r.phone,first_name:r.first_name,fps_bank_member_id:r.bank,bank_ref:r.bank},Date.now(),capability);
 if(result?.registered===false)return{status:'incomplete',missing_fields:['recipient_details'],reason:'payout_intake_incomplete'};
 if(!result?.id)throw Error('payout_intake_receipt_missing');
 const row=await env.DB.prepare('SELECT id,status,amount_minor,konsol_payment_id,execute_claim FROM ugc_payouts WHERE id=?1').bind(result.id).first();
 if(!row||row.status!=='awaiting_approval'||row.konsol_payment_id||row.execute_claim||row.amount_minor!==cart.amount_minor)throw Error('payout_approval_readback_failed');
 return{status:'registered',payout_id:row.id,amount_minor:row.amount_minor};
}
