import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from './types';
import { finishDianaCloud } from './lib/diana-cloud-lock';
import {dianaWorkWindow} from './lib/diana-work-window.mjs';
import {prepareReviewPlan} from './lib/diana-review-plan';
import { readCloudConversation, prepareCloudDecision, draftCloudDecision, deliverCloudDecision, completeCloudEvent,
  stateRead, stateWrite, cloudEventKey, handoffCloudPayout, type DianaCloudEvent } from './lib/diana-cloud';

// Each read/model step has at most three attempts. Durable send intents are never
// blindly retried by Workflows; only their separately persisted receipts allow resume.
// The managed native login is serialized. Allow a bounded fifteen-minute
// Dieter turn ahead of this read without cancelling/re-enqueuing the same call.
const READ = {retries:{limit:2,delay:'10 seconds' as const,backoff:'exponential' as const},timeout:'30 minutes' as const};
export class DianaCloudWorkflow extends WorkflowEntrypoint<Env,DianaCloudEvent> {
  async run(event:WorkflowEvent<DianaCloudEvent>,step:WorkflowStep) {
    const input=event.payload;let beforeExternalEffects=true;
    try {
      const defer=async(label:string)=>{
        if(input.dryRun||dianaWorkWindow(Date.now()).direct)return false;
        await step.do('defer-'+label,{retries:{limit:2,delay:'5 seconds'},timeout:'1 minute'},()=>
          stateWrite(this.env,cloudEventKey(input),{status:'deferred',reason:'outside_direct_hours',event_id:input.event_id,workflow_id:event.instanceId,...(input.recovery?{recovery_attempt:input.recoveryAttempt??1}:{}),at:Date.now()}));
        return true;
      };
      if(await defer('before-read'))return {status:'deferred'};
      const source=await step.do('read-original-conversation',READ,()=>readCloudConversation(this.env,input));
      let outcome:any=source;
      if (source.status==='ready' && source.key) {
        if(await defer('before-context'))return {status:'deferred'};
        const context=await step.do('load-diana-and-read-images',READ,()=>prepareCloudDecision(this.env,source.key!));
        outcome=context;
        if (context.status==='ready' && context.key) {
          if(await defer('before-decision'))return {status:'deferred'};
          const draft=await step.do('diana-native-terra-decision',READ,()=>draftCloudDecision(this.env,context.key!));
          if(await defer('before-payout-handoff'))return {status:'deferred'};
          const payout=await step.do('handoff-confirmed-requisites-to-payout',READ,()=>handoffCloudPayout(this.env,draft.key));
          if(payout.payout_id){
            // Requisites create an approval row, never a transfer. Only the
            // authenticated Owner's payment button may execute the payout.
            if(await defer('before-owner-approval'))return {status:'deferred'};
            outcome={status:'no_reply',reason:'Verified requisites saved in ERP; awaiting Owner payment approval.'};
          }else{
            if(await defer('before-delivery'))return {status:'deferred'};
            beforeExternalEffects=false;
            for(let attempt=0;attempt<3;attempt++){
              if(attempt)await step.sleep('meta-rate-limit-wait-'+attempt,'3 minutes');
              outcome=await step.do('deliver-durable-plan-'+attempt,{retries:{limit:0,delay:'1 second'},timeout:'5 minutes'},()=>deliverCloudDecision(this.env,draft.key));
              if(!outcome.retryable)break;
            }
          }
        }
      }
      if(['deferred','media_wait'].includes(outcome?.status))outcome={...outcome,workflow_id:event.instanceId,...(input.recovery?{recovery_attempt:input.recoveryAttempt??1}:{})};
      return await step.do('verify-meta-and-saved-result',READ,()=>completeCloudEvent(this.env,input,outcome));
    } catch (error) {
      const detail=String((error as Error)?.message??error);
      const technical=beforeExternalEffects&&/^(?:subscription_runner_http_(?:429|5\d\d)|diana_meta_read_http_(?:429|5\d\d)|diana_subscription_vision_pending|diana_context_unavailable: GitHub (?:429|5\d\d)|fetch failed|The operation was aborted)$/i.test(detail);
      const safeReason=technical?'recovery_technical_retryable':/^payout_execution_[a-z0-9_]+$/.test(detail)?detail:'cloud_workflow_step_failed';
      await step.do('record-pending-failure',{retries:{limit:2,delay:'5 seconds'},timeout:'1 minute'},()=>stateWrite(this.env,cloudEventKey(input),
        {status:'failed',event_id:input.event_id,reason:safeReason,workflow_id:event.instanceId,...(input.recovery?{recovery_attempt:input.recoveryAttempt??1}:{}),at:Date.now()}));
      if(!technical||!input.recovery||(input.recoveryAttempt??1)>=3)await step.do('prepare-owner-review',{retries:{limit:2,delay:'5 seconds'},timeout:'1 minute'},()=>prepareReviewPlan(this.env,input,{reason:safeReason}));
      throw error;
    } finally {
      // Conditional release cannot remove another workflow's lock. Preview
      // instances do not take the production lock.
      if (!input.dryRun) await step.do('release-diana-cloud-lock', {retries:{limit:2,delay:'5 seconds'},timeout:'1 minute'},
        async()=>{
          // An exception while recording failure must not leave a completed
          // workflow with no event state. Such an event must never be mistaken
          // for a fresh dispatch after the lock is released.
          const key=cloudEventKey(input);
          const previous=await stateRead(this.env,key);
          if(!previous||(input.recovery&&previous.status==='queued')||(previous.status==='deferred'&&previous.workflow_id!==event.instanceId))await stateWrite(this.env,key,{status:'needs_review',reason:'workflow_finished_without_event_receipt',event_id:input.event_id,workflow_id:event.instanceId,at:Date.now()});
          await finishDianaCloud(this.env,{kind:'direct',id:event.instanceId});
          const wake=this.env.DIANA_WAKE.get(this.env.DIANA_WAKE.idFromName('diana'));
          const response=await wake.fetch('https://diana/cloud-released',{method:'POST'});
          if(!response.ok)throw Error('diana_wake_after_release_failed');
        });
    }
  }
}
