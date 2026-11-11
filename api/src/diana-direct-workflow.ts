import {WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep} from 'cloudflare:workers';
import type {Env} from './types';
import {acknowledgeDianaEvent} from './lib/diana-alarm';
import {finishDianaCloud} from './lib/diana-cloud-lock';
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
import {runPayoutNotice,NOTICE_TASKS} from './lib/diana-direct-notice.mjs';
// @ts-expect-error plain JS module
import {directOutcomeState} from './lib/diana-direct-state.mjs';

export type DianaDirectSignal={cid:string;message_id:string;event_id:string;handle?:string;dryRun?:boolean;attempt?:number;task?:string;payout_id?:string};

export type DianaDirectPayload=DianaDirectSignal|{events:DianaDirectSignal[]};
export class DianaDirectWorkflow extends WorkflowEntrypoint<Env,DianaDirectPayload>{
 async run(event:WorkflowEvent<DianaDirectPayload>,step:WorkflowStep){
  const payload=event.payload;
  const signals='events' in payload?payload.events:[payload];
  if(!Array.isArray(signals)||!signals.length||signals.length>4||signals.some(x=>!x?.cid||(!x?.message_id&&!x?.task)||!x?.event_id))throw Error('direct_invalid_signals');
  const dryRun=signals.every(x=>x.dryRun===true);
  if(!dryRun&&signals.some(x=>x.dryRun))throw Error('direct_mixed_preview');
  try{
   return await step.do('read-decide-and-verify',{retries:{limit:0,delay:'10 seconds'},timeout:'30 minutes'},async()=>{
    const processOne=async(signal:DianaDirectSignal)=>{
    try{
     const infer=(messages:any,options:any={})=>directThink(this.env,options.model==='gpt-6.1-terra'?'reply':options.model==='gpt-6-luna'?'image':'context')(messages,options);
     if(signal.task&&NOTICE_TASKS.has(signal.task)){
      if(signal.dryRun)return {status:'preview',reason:'notice_preview_no_send'};
      const result=await runPayoutNotice({env:this.env,event:signal,token:this.env.META_IG_MESSAGING_TOKEN,infer,prepareContext:prepareDianaContext});
      if(result.status==='complete'){
       await this.env.DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind('diana_event_done:'+signal.event_id,JSON.stringify({event_id:signal.event_id,cid:signal.cid,message_id:signal.message_id??null,verified:true,proof:'Original Meta outgoing payout notice read back',outgoing_id:result.outgoing_id??null,executor:'diana_direct_workflow'}),Date.now()).run();
       await acknowledgeDianaEvent(this.env,signal as any);
      }
      const saved=directOutcomeState(result,signal.attempt??1);await this.env.DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind('diana_direct_event:'+signal.event_id,JSON.stringify(saved),Date.now()).run();
      return result;
     }
     const result=await runDirect({event:signal,
      readOriginal:({conversationId,messageId}:any)=>readDirectOriginal({conversationId,messageId,token:this.env.META_IG_MESSAGING_TOKEN}),
      decide:async(source:any)=>{
       const name=String(signal.handle??source.messages.at(-1)?.from?.username??'').toLowerCase().replace(/^@/,'');
       const creator=name?await this.env.DB.prepare("SELECT c.id,c.lifecycle_stage FROM ugc_creators c JOIN ugc_creator_platforms p ON p.creator_id=c.id WHERE p.platform='instagram' AND p.normalized_handle=?1 LIMIT 1").bind(name).first<any>():null;
       const payouts=creator?.id?(await this.env.DB.prepare('SELECT status,amount_minor,konsol_payment_id FROM ugc_payouts WHERE creator_id=?1 ORDER BY updated_at DESC LIMIT 5').bind(creator.id).all<any>()).results:[];
       return decideDirect({source,prepareContext:prepareDianaContext,infer,readImage:loadInstagramImage,env:this.env,facts:{stage:creator?.lifecycle_stage??null,payouts},finalAttempt:(signal.attempt??1)>=3});
      },
      handoffPayout:async({event:input,source}:any)=>{const out=await handoffDirectPayout({env:this.env,event:input,source,
       refreshOriginal:({conversationId,messageId}:any)=>readDirectOriginal({conversationId,messageId,token:this.env.META_IG_MESSAGING_TOKEN}),
       infer,readImage:loadInstagramImage});
       // Owner 2026-11-11: the payment message must find this chat later; keep only its id.
       if(out?.payout_id)await this.env.DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind('diana_payout_cid:'+out.payout_id,JSON.stringify({cid:String(input.cid),message_id:String(input.message_id),handle:String(input.handle??'')}),Date.now()).run();
       return out;},
      pendingAmount:async(source:any)=>{
       const name=String(signal.handle??source.messages.at(-1)?.from?.username??'').toLowerCase().replace(/^@/,'');
       if(!name)return false;
       const row=await this.env.DB.prepare("SELECT 1 AS present FROM ugc_payouts p JOIN ugc_creator_platforms cp ON cp.creator_id=p.creator_id WHERE cp.platform='instagram' AND cp.normalized_handle=?1 AND p.amount_minor=1 AND p.status IN ('awaiting_approval','approved') AND p.konsol_payment_id IS NULL AND p.execute_claim IS NULL LIMIT 1").bind(name).first<any>();
       return Boolean(row);
      },
      deliver:({conversationId,messageId,recipientId,text}:any)=>signal.dryRun?Promise.resolve({status:'preview'}):deliverDirectReply({db:this.env.DB,conversationId,messageId,recipientId,text,token:this.env.META_IG_MESSAGING_TOKEN}),
      saveProof:async(proof:any)=>{await this.env.DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind('diana_event_done:'+signal.event_id,JSON.stringify(proof),Date.now()).run();},
      acknowledge:(input:any)=>acknowledgeDianaEvent(this.env,input),
     });
     if(!signal.dryRun){const saved=directOutcomeState(result,signal.attempt??1);await this.env.DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind('diana_direct_event:'+signal.event_id,JSON.stringify(saved),Date.now()).run();}
     return result;
    }catch{
     // Never persist exceptions: upstream errors can contain private content.
     const result=directOutcomeState({status:'pending',reason:'direct_execution_failed'},signal.attempt??1);
     if(!signal.dryRun)await this.env.DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind('diana_direct_event:'+signal.event_id,JSON.stringify(result),Date.now()).run();
     return result;
    }
    };
    const results=await Promise.all(signals.map(processOne));
    return results.length===1?results[0]:{status:'batch_processed',results};
   });
  }finally{
   if(!dryRun)await step.do('release-direct-lock',{retries:{limit:2,delay:'5 seconds'},timeout:'1 minute'},async()=>{
    await finishDianaCloud(this.env,{kind:'direct',id:event.instanceId});
    await this.env.DB.prepare("DELETE FROM crm_sync_state WHERE key='diana_direct_active' AND value=?1").bind(event.instanceId).run();
    const wake=this.env.DIANA_WAKE.get(this.env.DIANA_WAKE.idFromName('diana'));
    await wake.fetch('https://diana/cloud-released',{method:'POST'});
   });
  }
 }
}
