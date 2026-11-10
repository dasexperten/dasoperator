import {WorkflowEntrypoint,type WorkflowEvent,type WorkflowStep} from 'cloudflare:workers';
import type {Env} from './types';
import {readCloudConversation,prepareCloudDecision,draftCloudDecision,deliverCloudDecision,completeCloudEvent,stateWrite,type DianaCloudEvent} from './lib/diana-cloud';
import {finishDianaCloud} from './lib/diana-cloud-lock';
import {roundCandidates} from './lib/diana-cloud-round-cohort';
import {reviewRoundCollab} from './lib/diana-round-collab';

type RoundInput={id:string;scheduled_at:number};
const READ={retries:{limit:2,delay:'10 seconds' as const,backoff:'exponential' as const},timeout:'30 minutes' as const};

export class DianaCloudRoundWorkflow extends WorkflowEntrypoint<Env,RoundInput> {
  async run(event:WorkflowEvent<RoundInput>,step:WorkflowStep) {
    const run=event.payload, owner={kind:'round' as const,id:event.instanceId};
    try {
      const cohort=await step.do('snapshot-round-cohort',READ,()=>roundCandidates(this.env));
      let reviewed=0,exceptions=0;
      for(let i=0;i<cohort.length;i++) {
        const person=cohort[i]!, key=`diana_round_receipt:${run.id}:${person.id}`;
        let result:any;
        if(!person.cid||!person.message_id||!person.message_at)result={status:'needs_review',reason:'original_conversation_identity_unavailable'};
        else {
          const input:DianaCloudEvent={cid:person.cid,message_id:person.message_id,event_id:`round:${run.id}:${person.id}`,
            creator_id:person.id,handle:person.normalized_handle,at:person.message_at,task:'round',round_slot:run.id};
          try {
            const source=await step.do(`round-${i}-read`,READ,()=>readCloudConversation(this.env,input));
            result=source;
            if(source.status==='ready'&&source.key){
              const context=await step.do(`round-${i}-context`,READ,()=>prepareCloudDecision(this.env,source.key!));result=context;
              if(context.status==='ready'&&context.key){
                const draft=await step.do(`round-${i}-decision`,READ,()=>draftCloudDecision(this.env,context.key!));
                result=await step.do(`round-${i}-deliver`,{retries:{limit:0,delay:'1 second'},timeout:'5 minutes'},()=>deliverCloudDecision(this.env,draft.key));
              }
            }
            const before=result;
            const verified=await step.do(`round-${i}-verify`,READ,()=>completeCloudEvent(this.env,input,before));
            result=verified.status==='complete'?{status:'reviewed',outcome:verified.outcome,proof:before.deliveryKey??before.reason}:verified;
          } catch(error) {result={status:'needs_review',reason:'cloud_round_step_failed',detail:String((error as Error)?.message??error).slice(0,160)};}
        }
        const collab=await step.do(`round-${i}-coauthor`,{retries:{limit:0,delay:'1 second'},timeout:'5 minutes'},
          ()=>reviewRoundCollab(this.env,person.id,person.normalized_handle));
        // A conversation decision does not verify publications.
        // invitations. Keep the successful conversation result as evidence,
        // but never mark the creator's entire round complete on that basis.
        if(result.status==='reviewed'){
          const conversation=result;
          result={status:'needs_review',reason:'publication_not_verified',conversation};
        }
        result.coauthor=collab;
        const manual=await this.env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind('manual_stage:'+person.id).first<{value:string}>();
        if(manual){
          try {const value=JSON.parse(manual.value);if(!value.reviewed_at)result.manual_stage='not_reviewed';}
          catch {result.manual_stage='invalid_record';}
        }
        if(result.status==='reviewed')reviewed++;else exceptions++;
        await step.do(`round-${i}-receipt`,READ,async()=>{
          const receipt={slot:run.id,creator_id:person.id,stage_before:person.lifecycle_stage,...result,checked_at:new Date().toISOString()};
          await stateWrite(this.env,key,receipt);
          const saved=await this.env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind(key).first<{value:string}>();
          if(!saved||JSON.parse(saved.value).creator_id!==person.id)throw Error('round_receipt_not_saved');
        });
      }
      // These phases have no cloud executor yet. A per-chat model response is
      // not proof of coauthor acceptance, publication checking or manual review.
      const outcome={status:'partial',cohort:cohort.length,reviewed,exceptions,
        remaining:['owner_button_review','manual_stage_and_message_review','publication_actions'],finished_at:new Date().toISOString()};
      await step.do('save-round-outcome',READ,()=>stateWrite(this.env,'diana_round_run:'+run.id,outcome));
      return outcome;
    } finally {
      await step.do('release-round-lock',{retries:{limit:2,delay:'5 seconds'},timeout:'1 minute'},async()=>{
        await finishDianaCloud(this.env,owner);
        const wake=this.env.DIANA_WAKE.get(this.env.DIANA_WAKE.idFromName('diana'));
        if(!(await wake.fetch('https://diana/cloud-released',{method:'POST'})).ok)throw Error('diana_round_wake_failed');
      });
    }
  }
}
