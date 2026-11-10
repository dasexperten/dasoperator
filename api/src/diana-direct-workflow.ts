import {reservePrepareExecution} from './lib/diana-direct-prepare-lock.mjs';
import {isPayoutNotice,runPayoutNotice} from './lib/diana-direct-notice.mjs';
import {readNoticeOriginal,sendNoticeAndVerify} from './lib/diana-direct-notice-meta.mjs';
import {decidePayoutNotice} from './lib/diana-direct-notice-decide.mjs';
import {mapKonsolStatus} from './lib/ugc-payouts.mjs';
import {WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep} from 'cloudflare:workers';
import type {Env} from './types';
import {acknowledgeDianaEvent} from './lib/diana-alarm';
import {finishDianaCloud,reserveDianaCloud,releaseDianaCloud,readDianaCloudLock} from './lib/diana-cloud-lock';
import {loadInstagramImage} from './lib/ig-dm-image-cache';
// These modules deliberately keep message content in one step's memory only.
// @ts-expect-error plain JS module
import {readDirectOriginal} from './lib/diana-direct-original.mjs';
// @ts-expect-error plain JS module
import {directThink} from './lib/diana-direct-think.mjs';
// @ts-expect-error plain JS module
import {decideDirect} from './lib/diana-direct-decide.mjs';
// @ts-expect-error plain JS module
import {deliverDirectReply} from './lib/diana-direct-deliver.mjs';
// @ts-expect-error plain JS module
import {runDirect} from './lib/diana-direct-run.mjs';
// @ts-expect-error plain JS module
import {handoffDirectPayout} from './lib/diana-direct-payout.mjs';
// @ts-expect-error plain JS module
import {prepareDianaContext} from './lib/diana-context.mjs';
// @ts-expect-error plain JS module
import {directOutcomeState} from './lib/diana-direct-state.mjs';

export type DianaDirectSignal={cid:string;message_id:string;event_id:string;handle?:string;dryRun?:boolean;preparePayoutOnly?:boolean;attempt?:number;task?:'payout_paid_notice'|'payout_failed_notice';payout_id?:string};

export type DianaDirectPayload=DianaDirectSignal|{events:DianaDirectSignal[]};
export class DianaDirectWorkflow extends WorkflowEntrypoint<Env,DianaDirectPayload>{
 async run(event:WorkflowEvent<DianaDirectPayload>,step:WorkflowStep){
  const payload=event.payload;
  const signals='events' in payload?payload.events:[payload];
  if(!Array.isArray(signals)||!signals.length||signals.length>4||signals.some(x=>!x?.cid||!x?.message_id||!x?.event_id))throw Error('direct_invalid_signals');
  if(new Set(signals.map(x=>x.cid)).size!==signals.length)throw Error('direct_duplicate_conversation');
  if(signals.some(x=>x.preparePayoutOnly!==undefined&&typeof x.preparePayoutOnly!=='boolean'))throw Error('direct_prepare_flag_invalid');
  const prepareOnly=signals.some(x=>x.preparePayoutOnly===true);
  if(prepareOnly&&(signals.length!==1||signals[0].task!==undefined||signals[0].payout_id!==undefined||signals[0].event_id!=='message:'+signals[0].message_id))throw Error('direct_prepare_incompatible_signal');
  const dryRun=signals.every(x=>x.dryRun===true);
  if(!dryRun&&signals.some(x=>x.dryRun))throw Error('direct_mixed_preview');
  const prepareOwner={kind:'direct' as const,id:event.instanceId};
  if(prepareOnly&&!dryRun&&!await reservePrepareExecution(this.env,prepareOwner,{reserve:reserveDianaCloud,read:readDianaCloudLock}))throw Error('direct_prepare_concurrency_blocked');
  try{
   return await step.do('read-decide-and-verify',{retries:{limit:0,delay:'10 seconds'},timeout:'30 minutes'},async()=>{
    const processOne=async(signal:DianaDirectSignal)=>{
    const stateKey=prepareOnly?'diana_direct_payout_prepare:'+signal.event_id+':'+event.instanceId:'diana_direct_event:'+signal.event_id;
    try{
     if(isPayoutNotice(signal)&&(this.env as any).DIANA_DIRECT_NOTICES_ENABLED!=='true')return {status:'pending',reason:'notice_admission_disabled'};
     const infer=(messages:any,options:any={})=>directThink(this.env,options.model==='gpt-6.1-terra'?'reply':options.model==='gpt-6-luna'?'image':'context')(messages,options);
     const notice=isPayoutNotice(signal);
     const result=notice?(signal.dryRun?{status:'preview',reason:'notice_preview_not_supported'}:await runPayoutNotice({db:this.env.DB,event:signal,workflowId:event.instanceId,mapProviderStatus:mapKonsolStatus,
      readOriginal:(cid:string)=>readNoticeOriginal({conversationId:cid,token:this.env.META_IG_MESSAGING_TOKEN}),
      decideNotice:({source,payout,task}:any)=>decidePayoutNotice({source,payout,task,prepareContext:prepareDianaContext,infer,env:this.env}),
      sendAndVerify:(input:any)=>sendNoticeAndVerify({...input,db:this.env.DB,token:this.env.META_IG_MESSAGING_TOKEN}),
     })):await runDirect({event:signal,
      readOriginal:({conversationId,messageId}:any)=>readDirectOriginal({conversationId,messageId,token:this.env.META_IG_MESSAGING_TOKEN}),
      decide:async(source:any)=>{
       const name=String(signal.handle??source.messages.at(-1)?.from?.username??'').toLowerCase().replace(/^@/,'');
       const creator=name?await this.env.DB.prepare("SELECT c.id,c.lifecycle_stage FROM ugc_creators c JOIN ugc_creator_platforms p ON p.creator_id=c.id WHERE p.platform='instagram' AND p.normalized_handle=?1 LIMIT 1").bind(name).first<any>():null;
       const payouts=creator?.id?(await this.env.DB.prepare('SELECT status,amount_minor,konsol_payment_id FROM ugc_payouts WHERE creator_id=?1 ORDER BY updated_at DESC LIMIT 5').bind(creator.id).all<any>()).results:[];
       return decideDirect({source,prepareContext:prepareDianaContext,infer,readImage:loadInstagramImage,env:this.env,facts:{stage:creator?.lifecycle_stage??null,payouts}});
      },
      handoffPayout:({event:input,source}:any)=>handoffDirectPayout({env:this.env,event:input,source,
       refreshOriginal:({conversationId,messageId}:any)=>readDirectOriginal({conversationId,messageId,token:this.env.META_IG_MESSAGING_TOKEN}),
       infer,readImage:loadInstagramImage}),
      deliver:({conversationId,messageId,recipientId,text}:any)=>prepareOnly?Promise.reject(Error('direct_prepare_send_forbidden')):signal.dryRun?Promise.resolve({status:'preview'}):deliverDirectReply({db:this.env.DB,conversationId,messageId,recipientId,text,token:this.env.META_IG_MESSAGING_TOKEN}),
      saveProof:async(proof:any)=>{await this.env.DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind('diana_event_done:'+signal.event_id,JSON.stringify(proof),Date.now()).run();},
      acknowledge:(input:any)=>acknowledgeDianaEvent(this.env,input),
     });
     if(notice&&!signal.dryRun&&result.status==='complete')await acknowledgeDianaEvent(this.env,signal);
     if(!signal.dryRun){const saved=directOutcomeState(result,signal.attempt??1);await this.env.DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind(stateKey,JSON.stringify(saved),Date.now()).run();}
     return result;
    }catch{
     // Never persist exceptions: upstream errors can contain private content.
     const result=directOutcomeState({status:'pending',reason:'direct_execution_failed'},signal.attempt??1);
     if(!signal.dryRun)await this.env.DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind(stateKey,JSON.stringify(result),Date.now()).run();
     return result;
    }
    };
    const results=await Promise.all(signals.map(processOne));
    return results.length===1?results[0]:{status:'batch_processed',results};
   });
  }finally{
   if(prepareOnly&&!dryRun)await step.do('release-prepare-lock',{retries:{limit:2,delay:'5 seconds'},timeout:'1 minute'},()=>releaseDianaCloud(this.env,prepareOwner));
   if(!dryRun&&!prepareOnly)await step.do('release-direct-lock',{retries:{limit:2,delay:'5 seconds'},timeout:'1 minute'},async()=>{
    await finishDianaCloud(this.env,{kind:'direct',id:event.instanceId});
    await this.env.DB.prepare("DELETE FROM crm_sync_state WHERE key='diana_direct_active' AND value=?1").bind(event.instanceId).run();
    const wake=this.env.DIANA_WAKE.get(this.env.DIANA_WAKE.idFromName('diana'));
    await wake.fetch('https://diana/cloud-released',{method:'POST'});
   });
  }
 }
}
