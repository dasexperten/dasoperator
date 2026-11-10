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
import {prepareDianaContext} from './lib/diana-context.mjs';

export type DianaDirectSignal={cid:string;message_id:string;event_id:string;handle?:string;dryRun?:boolean;attempt?:number};

export class DianaDirectWorkflow extends WorkflowEntrypoint<Env,DianaDirectSignal>{
 async run(event:WorkflowEvent<DianaDirectSignal>,step:WorkflowStep){
  const signal=event.payload;
  try{
   return await step.do('read-decide-and-verify',{retries:{limit:0,delay:'10 seconds'},timeout:'30 minutes'},async()=>{
    try{
     const infer=(messages:any,options:any={})=>directThink(this.env,options.model==='gpt-6.1-terra'?'reply':options.model==='gpt-6-luna'?'image':'context')(messages,options);
     const result=await runDirect({event:signal,
      readOriginal:({conversationId,messageId}:any)=>readDirectOriginal({conversationId,messageId,token:this.env.META_IG_MESSAGING_TOKEN}),
      decide:async(source:any)=>{
       const name=String(signal.handle??source.messages.at(-1)?.from?.username??'').toLowerCase().replace(/^@/,'');
       const creator=name?await this.env.DB.prepare("SELECT c.id,c.lifecycle_stage FROM ugc_creators c JOIN ugc_creator_platforms p ON p.creator_id=c.id WHERE p.platform='instagram' AND p.normalized_handle=?1 LIMIT 1").bind(name).first<any>():null;
       const payouts=creator?.id?(await this.env.DB.prepare('SELECT status,amount_minor,konsol_payment_id FROM ugc_payouts WHERE creator_id=?1 ORDER BY updated_at DESC LIMIT 5').bind(creator.id).all<any>()).results:[];
       return decideDirect({source,prepareContext:prepareDianaContext,infer,readImage:loadInstagramImage,env:this.env,facts:{stage:creator?.lifecycle_stage??null,payouts}});
      },
      deliver:({conversationId,messageId,recipientId,text}:any)=>signal.dryRun?Promise.resolve({status:'preview'}):deliverDirectReply({db:this.env.DB,conversationId,messageId,recipientId,text,token:this.env.META_IG_MESSAGING_TOKEN}),
      saveProof:async(proof:any)=>{await this.env.DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind('diana_event_done:'+signal.event_id,JSON.stringify(proof),Date.now()).run();},
      acknowledge:(input:any)=>acknowledgeDianaEvent(this.env,input),
     });
     if(!signal.dryRun){const retry=['original_attachment_unavailable','original_image_unreadable'].includes(result.reason);const saved={...result,attempt:signal.attempt??1,...(retry?{retry_at:Date.now()+180000}:{})};await this.env.DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind('diana_direct_event:'+signal.event_id,JSON.stringify(saved),Date.now()).run();}
     return result;
    }catch{
     // Never persist exceptions: upstream errors can contain private content.
     const result={status:'pending',reason:'direct_execution_failed',attempt:signal.attempt??1,retry_at:Date.now()+180000};
     if(!signal.dryRun)await this.env.DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind('diana_direct_event:'+signal.event_id,JSON.stringify(result),Date.now()).run();
     return result;
    }
   });
  }finally{
   if(!signal.dryRun)await step.do('release-direct-lock',{retries:{limit:2,delay:'5 seconds'},timeout:'1 minute'},async()=>{
    await finishDianaCloud(this.env,{kind:'direct',id:event.instanceId});
    await this.env.DB.prepare("DELETE FROM crm_sync_state WHERE key='diana_direct_active' AND value=?1").bind(event.instanceId).run();
    const wake=this.env.DIANA_WAKE.get(this.env.DIANA_WAKE.idFromName('diana'));
    await wake.fetch('https://diana/cloud-released',{method:'POST'});
   });
  }
 }
}
