// Read existing historical logs through CI-owned credentials. No model or upload.
// Never print exception text, prompts, headers, URLs, provider payloads or tokens.
import {pathToFileURL} from 'node:url';
export function closedEvent(event){
 const source=event.source??{},raw=JSON.stringify(source),worker=event.$workers??{};
 let message;try{message=JSON.parse(source.message);}catch{}
 if(message?.op&&message.op!=='dieter_round')return null;
 const classes=[['pipe_closed',/EPIPE|stdin_failed/],['connection_lost',/connection (?:lost|reset)|disconnect/i],['timeout',/timeout|timed out/i],['do_reset',/Durable Object reset/i],['proxy_failure',/proxying|container_http/i],['json_response_invalid',/Unexpected token|JSON.*(?:parse|position)/i],['native_failed',/native_.*failed|dieter_process_failed/],['turn_incomplete',/turn_incomplete/]];
 return {at:event.timestamp,entrypoint:worker.entrypoint,outcome:worker.outcome,wall_ms:worker.wallTimeMs,
  ...(message?.op==='dieter_round'?{operation:'dieter_round'}:{}),
  ...(typeof message?.req==='string'&&/^dieter-[a-f0-9-]+$/.test(message.req)?{request_ref:message.req}:{}),
  ...(Number.isFinite(message?.run_ms)?{run_ms:message.run_ms}:{}),
  classes:classes.filter(([,pattern])=>pattern.test(raw)).map(([name])=>name)};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [from,to]=process.argv.slice(2),start=Date.parse(from),end=Date.parse(to);
 if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>30*60*1000)throw Error('bounded_iso_timeframe_required');
 let success=false;
 for(const token of [process.env.T1,process.env.T2].filter(Boolean)){
  const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/workers/observability/telemetry/query`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({queryId:'dieter-runtime-incident-readonly',timeframe:{from:start,to:end},view:'events',limit:1000,parameters:{filters:[{key:'$metadata.service',operation:'eq',type:'string',value:'diana-subscription-runner'}]}})});
  let data;try{data=await response.json();}catch{}
  if(!response.ok||!data?.success){console.log(JSON.stringify({historical_log_access:false,http_status:response.status}));continue;}
  const events=data.result?.events?.events??[];
  for(const event of events){const closed=closedEvent(event);if(closed)console.log(JSON.stringify(closed));}
  console.log(JSON.stringify({historical_log_access:true,event_count:events.length}));success=true;break;
 }
 if(!success)process.exitCode=1;
}
