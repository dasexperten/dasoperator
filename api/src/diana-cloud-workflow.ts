import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from './types';
import { finishDianaCloud } from './lib/diana-cloud-lock';
import { readCloudConversation, prepareCloudDecision, draftCloudDecision, deliverCloudDecision, completeCloudEvent,
  stateWrite, cloudEventKey, handoffCloudPayout, executeCloudPayout, type DianaCloudEvent } from './lib/diana-cloud';

// Each read/model step has at most three attempts. Durable send intents are never
// blindly retried by Workflows; only their separately persisted receipts allow resume.
// The managed native login is serialized. Allow a bounded fifteen-minute
// Dieter turn ahead of this read without cancelling/re-enqueuing the same call.
const READ = {retries:{limit:2,delay:'10 seconds' as const,backoff:'exponential' as const},timeout:'30 minutes' as const};
export class DianaCloudWorkflow extends WorkflowEntrypoint<Env,DianaCloudEvent> {
  async run(event:WorkflowEvent<DianaCloudEvent>,step:WorkflowStep) {
    const input=event.payload;
    try {
      const source=await step.do('read-original-conversation',READ,()=>readCloudConversation(this.env,input));
      let outcome:any=source;
      if (source.status==='ready' && source.key) {
        const context=await step.do('load-diana-and-read-images',READ,()=>prepareCloudDecision(this.env,source.key!));
        outcome=context;
        if (context.status==='ready' && context.key) {
          const draft=await step.do('diana-native-terra-decision',READ,()=>draftCloudDecision(this.env,context.key!));
          const payout=await step.do('handoff-confirmed-requisites-to-payout',READ,()=>handoffCloudPayout(this.env,draft.key));
          if(payout.payout_id){
            await step.do('submit-payout-once',{retries:{limit:0,delay:'1 second'},timeout:'5 minutes'},()=>executeCloudPayout(this.env,payout.payout_id!,input));
            outcome={status:'no_reply',reason:'Verified requisites handed to ERP; payment notice follows provider confirmation.'};
          }else{
            for(let attempt=0;attempt<3;attempt++){
              if(attempt)await step.sleep('meta-rate-limit-wait-'+attempt,'3 minutes');
              outcome=await step.do('deliver-durable-plan-'+attempt,{retries:{limit:0,delay:'1 second'},timeout:'5 minutes'},()=>deliverCloudDecision(this.env,draft.key));
              if(!outcome.retryable)break;
            }
          }
        }
      }
      return await step.do('verify-meta-and-saved-result',READ,()=>completeCloudEvent(this.env,input,outcome));
    } catch (error) {
      await step.do('record-pending-failure',{retries:{limit:2,delay:'5 seconds'},timeout:'1 minute'},()=>stateWrite(this.env,cloudEventKey(input),
        {status:'failed',event_id:input.event_id,reason:'cloud_workflow_step_failed',workflow_id:event.instanceId,at:Date.now()}));
      throw error;
    } finally {
      // Conditional release cannot remove another workflow's lock. Preview
      // instances do not take the production lock.
      if (!input.dryRun) await step.do('release-diana-cloud-lock', {retries:{limit:2,delay:'5 seconds'},timeout:'1 minute'},
        async()=>{
          await finishDianaCloud(this.env,{kind:'direct',id:event.instanceId});
          const wake=this.env.DIANA_WAKE.get(this.env.DIANA_WAKE.idFromName('diana'));
          const response=await wake.fetch('https://diana/cloud-released',{method:'POST'});
          if(!response.ok)throw Error('diana_wake_after_release_failed');
        });
    }
  }
}
