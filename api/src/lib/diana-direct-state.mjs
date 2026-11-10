// Workflow outcomes hold metadata only, never message or image contents.
const RETRYABLE=new Set(['original_attachment_unavailable','original_image_unreadable','direct_execution_failed']);
export function directOutcomeState(result,attempt=1,now=Date.now()){
 const reason=String(result.reason??'');
 if(result.status==='pending'&&reason==='delivery_superseded')return {...result,status:'superseded',attempt};
 const retry=result.status==='pending'&&RETRYABLE.has(reason)&&attempt<3;
 const review=result.status==='pending'&&!retry;
 return {...result,attempt,...(retry?{retry_at:now+180000}:{}),...(review?{status:'needs_review',review_owner:'diana-helios',review_since_ms:now}:{})};
}
