import {WorkflowEntrypoint,type WorkflowEvent,type WorkflowStep} from 'cloudflare:workers';
import type {Env} from './types';
import {roundCandidates} from './lib/diana-cloud-round-cohort';
import {reviewRoundCollab} from './lib/diana-round-collab';
import {reviewRoundPublications} from './lib/diana-round-publications';
import {recordTaggedReels} from './lib/diana-round-tags';
import {recordCollabMedia,scanDirectContent} from './lib/ugc-direct-content';
import {confirmPendingContent} from './lib/ugc-content-confirm';
// @ts-expect-error plain JS module
import {watchVideo} from './lib/diana-direct-video-watch.mjs';
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
        }catch{return {status:'pending',reason:'round_execution_failed'};}
      }).catch(()=>({status:'pending',reason:'round_step_timeout'}));
      if(result.status==='answered')answered++;
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
    // Owner 2026-11-18: every waiting reel is checked — author, our product, views, likes, comments.
    // Four at a time, newest first, until the queue or the shared daily Apify budget ends.
    const content={selected:0,confirmed:0,not_ours:0,not_hers:0,unread:0,budget_exhausted:false};
    const tried:string[]=[],slow:string[]=[];
    const watch=(url:string)=>watchVideo({apiKey:(this.env as any).GEMINI_API_KEY,url});
    for(let n=0;n<40&&!content.budget_exhausted;n++){
      const part:any=await step.do(`content-check-${n}`,{retries:{limit:0,delay:'1 second'},timeout:'12 minutes'},async()=>{
        try{return await confirmPendingContent(this.env,{limit:4,budgetMs:8*60_000,exclude:tried,watch});}
        catch{return {selected:0,confirmed:0,not_ours:0,not_hers:0,unread:0,waiting:0,budget_exhausted:false,pending_ids:[],ids:[],failed:true};}
      }).catch(()=>({selected:0,failed:true,pending_ids:[],ids:[]}));
      if(part.failed||!part.selected)break;
      content.selected+=part.selected;content.confirmed+=part.confirmed;content.not_ours+=part.not_ours;content.not_hers+=part.not_hers;content.unread+=part.unread;content.budget_exhausted=Boolean(part.budget_exhausted);
      for(const id of part.pending_ids??[]){if(!slow.includes(id))slow.push(id);}
      // A reel looked at in this round is not offered again in it; slow readings get one more look below.
      for(const id of part.ids??[]){if(!tried.includes(id))tried.push(id);}
    }
    for(let n=0;n<slow.length&&n<40;n+=4){
      const part:any=await step.do(`content-check-slow-${n}`,{retries:{limit:0,delay:'1 second'},timeout:'12 minutes'},async()=>{try{return await confirmPendingContent(this.env,{limit:4,budgetMs:8*60_000,ids:slow.slice(n,n+4),watch});}catch{return {confirmed:0,not_ours:0,not_hers:0};}}).catch(()=>({confirmed:0,not_ours:0,not_hers:0}));
      content.confirmed+=Number(part.confirmed??0);content.not_ours+=Number(part.not_ours??0);content.not_hers+=Number(part.not_hers??0);
    }
    await step.do('save-round-summary',READ,async()=>{
      await this.env.DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
        .bind('diana_round_run:'+run.id,JSON.stringify({status:'complete',id:run.id,scheduled_at:run.scheduled_at,finished_at:Date.now(),cohort:cohort.length,totals,tagged_reels_recorded:tagged.recorded,invites_accepted:tagged.accepted,collab_media_recorded:collabMedia,direct_links:directLinks,direct_videos:directVideos,content_check:content}),Date.now()).run();
    });
    return {cohort:cohort.length,totals};
  }
}
