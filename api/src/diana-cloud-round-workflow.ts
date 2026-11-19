import {WorkflowEntrypoint,type WorkflowEvent,type WorkflowStep} from 'cloudflare:workers';
import type {Env} from './types';
import {roundCandidates,alarmCandidates} from './lib/diana-cloud-round-cohort';
import {reviewRoundCollab} from './lib/diana-round-collab';
import {reviewRoundPublications} from './lib/diana-round-publications';
import {recordTaggedReels} from './lib/diana-round-tags';
import {recordCollabMedia,scanDirectContent} from './lib/ugc-direct-content';
import {confirmPendingContent,pendingContentIds} from './lib/ugc-content-confirm';
import {fillMissingViews} from './lib/ugc-views-fill.mjs';
// @ts-expect-error plain JS module
import {watchVideo} from './lib/diana-direct-video-watch.mjs';
// @ts-expect-error plain JS module
import {matchDirectVideos} from './lib/ugc-direct-video-match.mjs';
import {instagramPostFallback} from './lib/ugc-apify.mjs';
// @ts-expect-error plain JS module
import {runRoundCreator,roundConversationId} from './lib/diana-round-run.mjs';
// @ts-expect-error plain JS module
import {directThink} from './lib/diana-direct-think.mjs';
// @ts-expect-error plain JS module
import {prepareDianaContext} from './lib/diana-context.mjs';

// Owner 2026-11-11: Diana Round is a separate process, 06:00 and 18:00 Yerevan.
// It never holds Diana Direct's lock, so incoming messages keep being answered.
type RoundInput={id:string;scheduled_at:number};
const READ={retries:{limit:2,delay:'10 seconds' as const,backoff:'exponential' as const},timeout:'5 minutes' as const};

export class DianaCloudRoundWorkflow extends WorkflowEntrypoint<Env,RoundInput> {
  async run(event:WorkflowEvent<RoundInput>,step:WorkflowStep) {
    const run=event.payload;
    // Owner 2026-11-12: first record every reel that tags us and accept pending co-author invitations,
    // so nobody who already posted is asked «когда ролик?». A failure here never stops the round.
    const tagged:any=await step.do('record-tagged-reels',{retries:{limit:1,delay:'10 seconds'},timeout:'5 minutes'},async()=>{try{const r:any=await recordTaggedReels(this.env);return {recorded:Number(r.recorded??0),accepted:Number(r.accepted??0)};}catch{return {recorded:-1,accepted:0};}}).catch(()=>({recorded:-1,accepted:0}));
    // Owner 2026-11-18: a Collab on her profile where we are the accepted co-author goes to her Контент.
    const collabMedia:number=await step.do('record-collab-media',{retries:{limit:1,delay:'10 seconds'},timeout:'5 minutes'},async()=>{try{return Number((await recordCollabMedia(this.env)).recorded??0);}catch{return -1;}}).catch(()=>-1);
    const cohort=await step.do('snapshot-round-cohort',READ,()=>roundCandidates(this.env));
    // Chats with her last word outside the cohort (any stage) are answered too; nothing else is done for them.
    const waiting=await step.do('snapshot-alarm-chats',READ,()=>alarmCandidates(this.env)).catch(()=>[] as any[]);
    const extra=waiting.filter((w:any)=>!cohort.some((c:any)=>c.id===w.id));
    const failures:Record<string,number>={};
    let directLinks=0,directVideos=0;
    const totals:Record<string,number>={};
    let answered=0;const ANSWERS_PER_ROUND=40;
    for(let i=0;i<cohort.length;i++){
      const person=cohort[i]!;
      // One step per blogger: a send is never repeated by a retry (limit 0).
      // 2026-11-12: one blogger's step timing out (slow model) is counted and skipped; before, it stopped the whole round.
      const result=await step.do(`round-${i}-${person.id}`,{retries:{limit:0,delay:'1 second'},timeout:'10 minutes'},async()=>{
        try{
          const infer=(messages:any,options:any={})=>directThink(this.env,options.model==='gpt-6.1-terra'?'reply':'context')(messages,options);
          const out=await runRoundCreator({env:this.env,runId:run.id,person,token:(this.env as any).META_IG_MESSAGING_TOKEN,infer,prepareContext:prepareDianaContext,answersLeft:ANSWERS_PER_ROUND-answered});
          return {status:String(out.status),reason:String(out.reason??'')};
        }catch(e){return {status:'pending',reason:'round_execution_failed',error:String((e as any)?.message??e).slice(0,80)};}
      }).catch(()=>({status:'pending',reason:'round_step_timeout'}));
      if(result.status==='answered')answered++;
      if((result as any).error)failures[(result as any).error]=(failures[(result as any).error]??0)+1;
      const label=result.status+(result.reason?':'+result.reason:'');totals[label]=(totals[label]??0)+1;
      // Kept from the old round (Owner 2026-11-11, ne_myr): published reels are matched to the
      // blogger and move her to «posted»; a Collab invitation is checked. Never retried.
      const once={retries:{limit:0,delay:'1 second' as const},timeout:'5 minutes' as const};
      const publication=await step.do(`round-${i}-publication`,once,async()=>{try{const r:any=await reviewRoundPublications(this.env,person.id,person.normalized_handle);return r?.reason==='publication_link_unavailable'?'none_yet':String(r?.status??'');}catch{return 'failed';}}).catch(()=>'timeout');
      const collab=await step.do(`round-${i}-coauthor`,once,async()=>{try{const r:any=await reviewRoundCollab(this.env,person.id,person.normalized_handle);return String(r?.status??'');}catch{return 'failed';}}).catch(()=>'timeout');
      totals['publication:'+publication]=(totals['publication:'+publication]??0)+1;totals['collab:'+collab]=(totals['collab:'+collab]??0)+1;
      // Owner 2026-11-18 (o__kseniaa): a reel or a video she sent in Direct lands in her Контент even
      // when nobody was looking at the chat at that moment.
      const direct=await step.do(`round-${i}-direct-content`,once,async()=>{try{const cid=await roundConversationId(this.env,person);if(!cid)return {links:0,videos:0};const r=await scanDirectContent(this.env,person.normalized_handle,String(cid));return {links:Number(r.links),videos:Number(r.videos)};}catch{return {links:0,videos:0};}}).catch(()=>({links:0,videos:0}));
      directLinks+=direct.links;directVideos+=direct.videos;
    }
    for(let i=0;i<extra.length;i++){
      const person=extra[i]!;
      const result:any=await step.do(`round-alarm-${i}-${person.id}`,{retries:{limit:0,delay:'1 second'},timeout:'10 minutes'},async()=>{
        try{
          const infer=(messages:any,options:any={})=>directThink(this.env,options.model==='gpt-6.1-terra'?'reply':'context')(messages,options);
          const out=await runRoundCreator({env:this.env,runId:run.id,person,token:(this.env as any).META_IG_MESSAGING_TOKEN,infer,prepareContext:prepareDianaContext,answersLeft:ANSWERS_PER_ROUND-answered,answerOnly:true});
          return {status:String(out.status),reason:String(out.reason??'')};
        }catch(e){return {status:'pending',reason:'round_execution_failed',error:String((e as any)?.message??e).slice(0,80)};}
      }).catch(()=>({status:'pending',reason:'round_step_timeout'}));
      if(result.status==='answered')answered++;
      if(result.error)failures[result.error]=(failures[result.error]??0)+1;
      const label='alarm:'+result.status+(result.reason?':'+result.reason:'');totals[label]=(totals[label]??0)+1;
    }
    // Owner 2026-11-18: every waiting reel is checked — author, our product, views, likes, comments.
    // Newest first, until the queue or the shared daily Apify budget ends.
    const content={selected:0,confirmed:0,not_ours:0,not_hers:0,unread:0,failed_steps:0,budget_exhausted:false};
    const tried:string[]=[],slow:string[]=[];
    const watch=(url:string)=>watchVideo({apiKey:(this.env as any).GEMINI_API_KEY,url});
    const checkStep={retries:{limit:0,delay:'1 second' as const},timeout:'12 minutes' as const};
    // 2026-11-18 evening: one step died inside Cloudflare and the whole check stopped at 8 reels.
    // The reels are now picked in a cheap step of their own and read two at a time, so a dead step
    // costs two reels (they are tried again next round), never the queue. Three dead steps in a row stop it.
    // Owner 2026-11-18, priority 1: plays first, newest reel first, ten at a time; a dead step costs ten reels at most.
    const views={filled:0,pending:0,no_views:0,failed_steps:0};const viewed:string[]=[];
    for(let n=0;n<3;n++){
      const part:any=await step.do(`views-fill-${n}`,checkStep,async()=>{try{return await fillMissingViews(this.env,{limit:10,budgetMs:6*60_000,exclude:viewed});}catch{return {failed:true};}}).catch(()=>({failed:true}));
      if(part.failed){views.failed_steps++;continue;}
      viewed.push(...(part.ids??[]));
      views.filled+=Number(part.filled??0);views.pending+=Number(part.pending??0);views.no_views+=Number(part.no_views??0);
      if(part.budget_exhausted||!(part.ids??[]).length)break;
    }
    let dead=0;
    for(let n=0;n<20&&!content.budget_exhausted&&dead<3;n++){
      const picked:string[]=await step.do(`content-pick-${n}`,READ,()=>pendingContentIds(this.env,{limit:8,exclude:tried})).catch(()=>[]);
      if(!picked.length)break;
      tried.push(...picked);content.selected+=picked.length;
      for(let k=0;k<picked.length&&!content.budget_exhausted&&dead<3;k+=2){
        const part:any=await step.do(`content-check-${n}-${k}`,checkStep,async()=>{
          try{return await confirmPendingContent(this.env,{limit:2,budgetMs:8*60_000,ids:picked.slice(k,k+2),watch});}
          catch{return {failed:true};}
        }).catch(()=>({failed:true}));
        if(part.failed){dead++;content.failed_steps++;continue;}
        dead=0;
        content.confirmed+=Number(part.confirmed??0);content.not_ours+=Number(part.not_ours??0);content.not_hers+=Number(part.not_hers??0);content.unread+=Number(part.unread??0);content.budget_exhausted=Boolean(part.budget_exhausted);
        for(const id of part.pending_ids??[]){if(!slow.includes(id))slow.push(id);}
      }
    }
    for(let n=0;n<slow.length&&n<40&&dead<3;n+=2){
      const part:any=await step.do(`content-check-slow-${n}`,checkStep,async()=>{try{return await confirmPendingContent(this.env,{limit:2,budgetMs:8*60_000,ids:slow.slice(n,n+2),watch});}catch{return {failed:true};}}).catch(()=>({failed:true}));
      if(part.failed){dead++;content.failed_steps++;continue;}
      content.confirmed+=Number(part.confirmed??0);content.not_ours+=Number(part.not_ours??0);content.not_hers+=Number(part.not_hers??0);
    }
    // Owner 2026-11-19: a video she sent in Direct and then published the same, frame for frame, is shown once.
    // Each sent file is compared with her live publications; only «identical» links the two.
    const videoMatch:any=await step.do('direct-video-match',checkStep,async()=>{try{return await matchDirectVideos(this.env,{limit:6,budgetMs:8*60_000,read:instagramPostFallback});}catch{return {failed:true};}}).catch(()=>({failed:true}));
    await step.do('save-round-summary',READ,async()=>{
      await this.env.DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
        .bind('diana_round_run:'+run.id,JSON.stringify({status:'complete',id:run.id,scheduled_at:run.scheduled_at,finished_at:Date.now(),cohort:cohort.length,totals,views,tagged_reels_recorded:tagged.recorded,invites_accepted:tagged.accepted,collab_media_recorded:collabMedia,direct_links:directLinks,direct_videos:directVideos,direct_video_match:videoMatch,content_check:content,alarm_chats:extra.length,failures}),Date.now()).run();
    });
    return {cohort:cohort.length,totals};
  }
}
