import {WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep} from 'cloudflare:workers';
import type {Env} from './types';
import {acknowledgeDianaEvent} from './lib/diana-alarm';
import {finishDianaCloud} from './lib/diana-cloud-lock';
import {loadInstagramImage} from './lib/ig-dm-image-cache';
// These modules deliberately keep message content in one step's memory only.
// @ts-expect-error plain JS module
import {readDirectOriginal} from './lib/diana-direct-original.mjs';
import {applyShares} from './lib/ig-share-webhook.mjs';
import {latestRequisites} from './lib/ugc-latest-requisites.mjs';
// @ts-expect-error plain JS module
import {directThink} from './lib/diana-direct-think.mjs';
// @ts-expect-error plain JS module
import {decideDirect} from './lib/diana-direct-decide.mjs';
// @ts-expect-error plain JS module
import {findPublication,acceptInvite} from './lib/diana-direct-collab.mjs';
// @ts-expect-error plain JS module
import {watchVideo} from './lib/diana-direct-video-watch.mjs';
// @ts-expect-error plain JS module
import {deliverDirectReply} from './lib/diana-direct-deliver.mjs';
// @ts-expect-error plain JS module
import {SCENARIO_CARDS} from './lib/ig-dm-reply-guard.mjs';
// @ts-expect-error plain JS module
import {runDirect} from './lib/diana-direct-run.mjs';
// @ts-expect-error plain JS module
import {agreedExtra as findAgreedExtra} from './lib/ugc-agreed-extra.mjs';
// @ts-expect-error plain JS module
import {leadStage} from './lib/ugc-lead-stage.mjs';
// @ts-expect-error plain JS module
import {handoffDirectPayout} from './lib/diana-direct-payout.mjs';
// @ts-expect-error plain JS module
import {prepareDianaContext} from './lib/diana-context.mjs';
// @ts-expect-error plain JS module
import {runPayoutNotice,runOwnerChoice,runGoldWelcome,runLeadNudge,scheduleLeadNudge,NOTICE_TASKS,OWNER_CHOICE_TASK,GOLD_TASK,NUDGE_TASK,IDEA_LINES} from './lib/diana-direct-notice.mjs';
// @ts-expect-error plain JS module
import {directOutcomeState} from './lib/diana-direct-state.mjs';

export type DianaDirectSignal={cid:string;message_id:string;event_id:string;handle?:string;dryRun?:boolean;attempt?:number;task?:string;payout_id?:string;question_id?:string;revisit?:boolean};

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
     if(signal.task&&(NOTICE_TASKS.has(signal.task)||signal.task===OWNER_CHOICE_TASK||signal.task===GOLD_TASK||signal.task===NUDGE_TASK)){
      if(signal.dryRun)return {status:'preview',reason:'task_preview_no_send'};
      const run=signal.task===OWNER_CHOICE_TASK?runOwnerChoice:signal.task===GOLD_TASK?runGoldWelcome:signal.task===NUDGE_TASK?runLeadNudge:runPayoutNotice;
      const result=await run({env:this.env,event:signal,token:this.env.META_IG_MESSAGING_TOKEN,infer,prepareContext:prepareDianaContext});
      if(result.status==='complete'){
       await this.env.DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind('diana_event_done:'+signal.event_id,JSON.stringify({event_id:signal.event_id,cid:signal.cid,message_id:signal.message_id??null,verified:true,proof:'Original Meta outgoing payout notice read back',outgoing_id:result.outgoing_id??null,executor:'diana_direct_workflow'}),Date.now()).run();
       await acknowledgeDianaEvent(this.env,signal as any);
      }
      const saved=directOutcomeState(result,signal.attempt??1);await this.env.DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind('diana_direct_event:'+signal.event_id,JSON.stringify(saved),Date.now()).run();
      return result;
     }
     const result=await runDirect({event:signal,
      readOriginal:async({conversationId,messageId}:any)=>{const source:any=await readDirectOriginal({conversationId,messageId,token:this.env.META_IG_MESSAGING_TOKEN});if(source?.status==='ready')await applyShares(this.env.DB,source.messages).catch(()=>0);return source;},
      decide:async(source:any)=>{
       const name=String(signal.handle??source.messages.at(-1)?.from?.username??'').toLowerCase().replace(/^@/,'');
       const creator=name?await this.env.DB.prepare("SELECT c.id,c.lifecycle_stage FROM ugc_creators c JOIN ugc_creator_platforms p ON p.creator_id=c.id WHERE p.platform='instagram' AND p.normalized_handle=?1 LIMIT 1").bind(name).first<any>():null;
       const payouts=creator?.id?(await this.env.DB.prepare('SELECT status,amount_minor,konsol_payment_id FROM ugc_payouts WHERE creator_id=?1 ORDER BY updated_at DESC LIMIT 5').bind(creator.id).all<any>()).results:[];
       return decideDirect({source,prepareContext:prepareDianaContext,infer,readImage:loadInstagramImage,env:this.env,facts:{stage:creator?.lifecycle_stage??null,payouts},finalAttempt:(signal.attempt??1)>=3||signal.revisit===true,revisit:signal.revisit===true,
        // Owner 2026-11-12: blank or video message → her reel from the official lists; an invite is accepted (always yes).
        watchVideo:(url:string)=>watchVideo({apiKey:this.env.GEMINI_API_KEY,url}),
        lookupPublication:async({handle,at}:any)=>{const p:any=await findPublication({token:this.env.META_IG_MESSAGING_TOKEN,handle,at,seen:async(id:string)=>Boolean(await this.env.DB.prepare('SELECT 1 x FROM crm_sync_state WHERE key=?1').bind('diana_publication_seen:'+id).first())});if(!p)return null;
         const accepted=p.kind==='invite'&&!signal.dryRun?await acceptInvite({page:p.page,mediaId:p.media_id}):false;
         await this.env.DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind('diana_publication_seen:'+p.media_id,JSON.stringify({handle,kind:p.kind,media_id:p.media_id,permalink:p.permalink??null,accepted}),Date.now()).run();
         return {kind:p.kind,accepted,permalink:p.permalink??null,caption:p.caption,published_at:p.published_at??null};}});
      },
      handoffPayout:async({event:input,source}:any)=>{const out=await handoffDirectPayout({env:this.env,event:input,source,
       refreshOriginal:async({conversationId,messageId}:any)=>{const source:any=await readDirectOriginal({conversationId,messageId,token:this.env.META_IG_MESSAGING_TOKEN});if(source?.status==='ready')await applyShares(this.env.DB,source.messages).catch(()=>0);return source;},
       infer,readImage:loadInstagramImage});
       // Owner 2026-11-11: the payment message must find this chat later; keep only its id.
       if(out?.payout_id)await this.env.DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind('diana_payout_cid:'+out.payout_id,JSON.stringify({cid:String(input.cid),message_id:String(input.message_id),handle:String(input.handle??'')}),Date.now()).run();
       return out;},
      markFee:async(source:any)=>{
       const name=String(signal.handle??source.messages.at(-1)?.from?.username??'').toLowerCase().replace(/^@/,'');
       if(!name)return;
       // A blogger who answered a first invitation with a price list has no card yet: she gets one, status fee.
       const sid=async(prefix:string,input:string)=>{const d=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(input));return prefix+'_'+[...new Uint8Array(d)].map(x=>x.toString(16).padStart(2,'0')).join('').slice(0,24);};
       const has=await this.env.DB.prepare("SELECT 1 x FROM ugc_creator_platforms WHERE platform='instagram' AND normalized_handle=?1 LIMIT 1").bind(name).first();
       if(!has&&/^[a-z0-9_.]{1,40}$/.test(name)){const cid=await sid('ugc','instagram:'+name),pid=await sid('ugcp','instagram:'+name),now=Date.now();
        await this.env.DB.batch([
         this.env.DB.prepare("INSERT INTO ugc_creators (id,normalized_handle,lifecycle_stage,origin,created_at,updated_at) VALUES (?1,?2,'fee','invited',?3,?3) ON CONFLICT(id) DO NOTHING").bind(cid,name,now),
         this.env.DB.prepare("INSERT INTO ugc_creator_platforms (id,creator_id,platform,handle,normalized_handle,profile_url,source,created_at,updated_at) VALUES (?1,?2,'instagram',?3,?3,?4,'diana_direct',?5,?5) ON CONFLICT(platform,normalized_handle) DO NOTHING").bind(pid,cid,name,'https://www.instagram.com/'+name+'/',now)]);
        return;}
       // Only a creator we never paid moves to fee; a hand-set status is never overwritten.
       await this.env.DB.prepare(`UPDATE ugc_creators SET lifecycle_stage='fee',updated_at=?2 WHERE id IN (SELECT creator_id FROM ugc_creator_platforms WHERE platform='instagram' AND normalized_handle=?1)
         AND COALESCE(lifecycle_stage,'') IN ('','found','first_contact','invited','replied','agreed','cart','silent')
         AND NOT EXISTS (SELECT 1 FROM ugc_payouts p WHERE p.creator_id=ugc_creators.id)
         AND NOT EXISTS (SELECT 1 FROM crm_sync_state WHERE key='manual_stage:'||ugc_creators.id)`).bind(name,Date.now()).run();
      },
      markLead:async(source:any)=>{
       const name=String(signal.handle??source.messages.at(-1)?.from?.username??'').toLowerCase().replace(/^@/,'');
       if(!/^[a-z0-9_.]{1,40}$/.test(name))return;
       const ours=new Set(['1697038263872226','17841466350261166']);
       const msgs=source.messages??[];let k=msgs.length-1;const mine:string[]=[];
       while(k>=0&&!ours.has(String(msgs[k].from?.id??''))){if(typeof msgs[k].message==='string')mine.unshift(msgs[k].message);k--;}
       const stage=leadStage(mine);if(!stage)return;
       const now=Date.now();
       const known=await this.env.DB.prepare("SELECT c.id,c.lifecycle_stage s FROM ugc_creators c JOIN ugc_creator_platforms p ON p.creator_id=c.id WHERE p.platform='instagram' AND p.normalized_handle=?1 LIMIT 1").bind(name).first<any>();
       if(known){
        // Only a scouting card moves up; a working or hand-set status is never touched.
        await this.env.DB.prepare(`UPDATE ugc_creators SET lifecycle_stage=?2,updated_at=?3 WHERE id=?1 AND COALESCE(lifecycle_stage,'') IN ('','found','first_contact','invited','silent',CASE WHEN ?2='agreed' THEN 'replied' ELSE '' END)
          AND NOT EXISTS (SELECT 1 FROM crm_sync_state WHERE key='manual_stage:'||ugc_creators.id)`).bind(known.id,stage,now).run();
        return;
       }
       const sid=async(prefix:string,input:string)=>{const d=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(input));return prefix+'_'+[...new Uint8Array(d)].map(x=>x.toString(16).padStart(2,'0')).join('').slice(0,24);};
       const cid=await sid('ugc','instagram:'+name),pid=await sid('ugcp','instagram:'+name);
       await this.env.DB.batch([
        this.env.DB.prepare("INSERT INTO ugc_creators (id,normalized_handle,lifecycle_stage,origin,created_at,updated_at,accepted_at) VALUES (?1,?2,?3,'invited',?4,?4,CASE WHEN ?3='agreed' THEN ?4 END) ON CONFLICT(id) DO NOTHING").bind(cid,name,stage,now),
        this.env.DB.prepare("INSERT INTO ugc_creator_platforms (id,creator_id,platform,handle,normalized_handle,profile_url,source,created_at,updated_at) VALUES (?1,?2,'instagram',?3,?3,?4,'diana_direct',?5,?5) ON CONFLICT(platform,normalized_handle) DO NOTHING").bind(pid,cid,name,'https://www.instagram.com/'+name+'/',now)]);
      },
      agreedExtra:async(source:any)=>{
       const name=String(signal.handle??source.messages.at(-1)?.from?.username??'').toLowerCase().replace(/^@/,'');
       if(!name)return;
       const rows=(source.messages??[]).map((m:any)=>({id:String(m.id),direction:['1697038263872226','17841466350261166'].includes(String(m.from?.id??''))?'out':'in',text:typeof m.message==='string'?m.message:'',created_at:new Date(Date.parse(m.created_time)||0).toISOString()}));
       const deal=findAgreedExtra(rows);
       if(!deal)return;
       const key='agreed_extra:'+deal.agreement_message_id;
       if(await this.env.DB.prepare('SELECT 1 x FROM crm_sync_state WHERE key=?1').bind(key).first())return;
       // Details of her last paid payout; without one, Diana's ordinary requisites flow takes over.
       const base=await this.env.DB.prepare("SELECT p.* FROM ugc_payouts p JOIN ugc_creator_platforms cp ON cp.creator_id=p.creator_id WHERE cp.platform='instagram' AND cp.normalized_handle=?1 AND p.status='paid' AND p.fps_bank_member_id IS NOT NULL ORDER BY p.created_at DESC LIMIT 1").bind(name).first<any>();
       if(!base)return;
       const already=await this.env.DB.prepare("SELECT 1 x FROM ugc_payouts WHERE creator_id=?1 AND amount_minor=?2 AND created_at>=?3 LIMIT 1").bind(base.creator_id,deal.amount_minor,deal.agreed_at-86400000).first();
       const now=Date.now();
       if(!already){
        const id='ugcpay_'+crypto.randomUUID().replace(/-/g,'').slice(0,24);
        const day=new Date(now+4*3600000).toISOString().slice(0,10);
        const note='Доплата '+(deal.amount_minor/100)+' ₽ по согласию Владельца в чате ('+new Date(deal.agreed_at+4*3600000).toISOString().slice(0,16).replace('T',' ')+'). Реквизиты прошлой выплаты.';
        await this.env.DB.batch([
         this.env.DB.prepare("INSERT INTO ugc_payouts (id,creator_id,creator_platform_id,platform,handle,amount_minor,currency,status,payout_date,marketplace,phone_masked,bank_ref,note,created_by,created_at,updated_at,fps_bank_member_id,konsol_contractor_id,product) VALUES (?1,?2,?3,?4,?5,?6,'RUB','awaiting_approval',?7,?8,?9,?10,?11,'owner_agreement',?12,?12,?13,?14,?15)")
          .bind(id,base.creator_id,base.creator_platform_id,base.platform,base.handle,deal.amount_minor,day,base.marketplace,base.phone_masked,base.bank_ref,note,now,base.fps_bank_member_id,base.konsol_contractor_id,base.product),
         this.env.DB.prepare("INSERT INTO ugc_payout_requisites (payout_id,fps_mobile_phone,first_name,last_name,patronymic,created_at,updated_at) SELECT ?1,fps_mobile_phone,first_name,last_name,patronymic,?2,?2 FROM ugc_payout_requisites WHERE payout_id=?3").bind(id,now,base.id),
        ]);
       }
       await this.env.DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO NOTHING').bind(key,JSON.stringify({amount_minor:deal.amount_minor,agreed_at:deal.agreed_at}),now).run();
      },
      pendingAmount:async(source:any)=>{
       const name=String(signal.handle??source.messages.at(-1)?.from?.username??'').toLowerCase().replace(/^@/,'');
       if(!name)return false;
       const row=await this.env.DB.prepare("SELECT 1 AS present FROM ugc_payouts p JOIN ugc_creator_platforms cp ON cp.creator_id=p.creator_id WHERE cp.platform='instagram' AND cp.normalized_handle=?1 AND p.amount_minor=1 AND p.status IN ('awaiting_approval','approved') AND p.konsol_payment_id IS NULL AND p.execute_claim IS NULL LIMIT 1").bind(name).first<any>();
       if(row)return true;
       // Owner 2026-11-11 (_bikmatinki, medisamiasi): phone, bank and name in the chat make the
       // button before any reply, whatever the model chose. «Реквизиты получила» is then true.
       const rows=(source.messages??[]).map((m:any)=>({id:String(m.id),direction:['1697038263872226','17841466350261166'].includes(String(m.from?.id??''))?'out':'in',text:typeof m.message==='string'?m.message:'',created_at:new Date(Date.parse(m.created_time)||0).toISOString()}));
       let req:any=null;try{req=latestRequisites(rows);}catch{}
       if(!req)return false;
       const paid=await this.env.DB.prepare("SELECT 1 AS present FROM ugc_payouts p JOIN ugc_creator_platforms cp ON cp.creator_id=p.creator_id WHERE cp.platform='instagram' AND cp.normalized_handle=?1 AND p.created_at>=?2 LIMIT 1").bind(name,Number(req.source_at)-3*86400000).first<any>();
       return !paid;
      },
      deliver:({conversationId,messageId,recipientId,text}:any)=>signal.dryRun?Promise.resolve({status:'preview'}):deliverDirectReply({db:this.env.DB,conversationId,messageId,recipientId,text,token:this.env.META_IG_MESSAGING_TOKEN})
       // Owner 2026-11-13: after Diana writes to a lead, a nudge is due in 3 hours unless she answers.
       .then(async(r:any)=>{if(r?.status==='verified')await scheduleLeadNudge(this.env.DB,{cid:conversationId,handle:signal.handle}).catch(()=>false);return r;}),
      // Owner 2026-11-12: the four approved scenario cards (DIRECT_RULES «Сценарии»), two short lines first.
      deliverCards:({conversationId,messageId,recipientId}:any)=>signal.dryRun?Promise.resolve({status:'preview'}):deliverDirectReply({db:this.env.DB,conversationId,messageId,recipientId,
       text:IDEA_LINES[0],followTexts:IDEA_LINES.slice(1),images:SCENARIO_CARDS,token:this.env.META_IG_MESSAGING_TOKEN}),
      saveProof:async(proof:any)=>{await this.env.DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind('diana_event_done:'+signal.event_id,JSON.stringify(proof),Date.now()).run();},
      acknowledge:(input:any)=>acknowledgeDianaEvent(this.env,input),
     });
     if(!signal.dryRun){const saved={...directOutcomeState(result,signal.attempt??1),...(signal.revisit?{revisited:true}:{})};await this.env.DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind('diana_direct_event:'+signal.event_id,JSON.stringify(saved),Date.now()).run();}
     return result;
    }catch{
     // Never persist exceptions: upstream errors can contain private content.
     // 2026-11-12: a failed second look is final too; without the mark it was retried every 10 minutes for ever.
     const result={...directOutcomeState({status:'pending',reason:'direct_execution_failed'},signal.attempt??1),...(signal.revisit?{revisited:true}:{})};
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
