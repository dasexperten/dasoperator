import {WorkflowEntrypoint,type WorkflowEvent,type WorkflowStep} from 'cloudflare:workers';
import type {Env} from './types';
import {roundCandidates} from './lib/diana-cloud-round-cohort';
import {reviewRoundCollab} from './lib/diana-round-collab';
import {reviewRoundPublications} from './lib/diana-round-publications';
import {recordTaggedReels} from './lib/diana-round-tags';
// @ts-expect-error plain JS module
import {runRoundCreator} from './lib/diana-round-run.mjs';
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
    const cohort=await step.do('snapshot-round-cohort',READ,()=>roundCandidates(this.env));
    const totals:Record<string,number>={};
    for(let i=0;i<cohort.length;i++){
      const person=cohort[i]!;
      // One step per blogger: a send is never repeated by a retry (limit 0).
      // 2026-11-12: one blogger's step timing out (slow model) is counted and skipped; before, it stopped the whole round.
      const result=await step.do(`round-${i}-${person.id}`,{retries:{limit:0,delay:'1 second'},timeout:'10 minutes'},async()=>{
        try{
          const infer=(messages:any,options:any={})=>directThink(this.env,options.model==='gpt-6.1-terra'?'reply':'context')(messages,options);
          const out=await runRoundCreator({env:this.env,runId:run.id,person,token:(this.env as any).META_IG_MESSAGING_TOKEN,infer,prepareContext:prepareDianaContext});
          return {status:String(out.status),reason:String(out.reason??'')};
        }catch{return {status:'pending',reason:'round_execution_failed'};}
      }).catch(()=>({status:'pending',reason:'round_step_timeout'}));
      const label=result.status+(result.reason?':'+result.reason:'');totals[label]=(totals[label]??0)+1;
      // Kept from the old round (Owner 2026-11-11, ne_myr): published reels are matched to the
      // blogger and move her to «posted»; a Collab invitation is checked. Never retried.
      const once={retries:{limit:0,delay:'1 second' as const},timeout:'5 minutes' as const};
      const publication=await step.do(`round-${i}-publication`,once,async()=>{try{const r:any=await reviewRoundPublications(this.env,person.id,person.normalized_handle);return r?.reason==='publication_link_unavailable'?'none_yet':String(r?.status??'');}catch{return 'failed';}}).catch(()=>'timeout');
      const collab=await step.do(`round-${i}-coauthor`,once,async()=>{try{const r:any=await reviewRoundCollab(this.env,person.id,person.normalized_handle);return String(r?.status??'');}catch{return 'failed';}}).catch(()=>'timeout');
      totals['publication:'+publication]=(totals['publication:'+publication]??0)+1;totals['collab:'+collab]=(totals['collab:'+collab]??0)+1;
    }
    await step.do('save-round-summary',READ,async()=>{
      await this.env.DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
        .bind('diana_round_run:'+run.id,JSON.stringify({status:'complete',id:run.id,scheduled_at:run.scheduled_at,finished_at:Date.now(),cohort:cohort.length,totals,tagged_reels_recorded:tagged.recorded,invites_accepted:tagged.accepted}),Date.now()).run();
    });
    return {cohort:cohort.length,totals};
  }
}
