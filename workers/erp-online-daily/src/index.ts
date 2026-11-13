import {erpWorker,type BaseEnv} from '../../_shared/run';
import {saveBoardReceipt} from './board.mjs';
interface Env extends BaseEnv{ONLINE_DAILY:Fetcher;ORG_DB:D1Database}
const timer=erpWorker<Env>('erp-online-daily',async(env,dry,_cron,context)=>{
 if(dry)return {note:'dry · no source reads or Telegram send'};
 const at=context.scheduledTime??Date.now();
 let data:any;
 try {
  const response=await env.ONLINE_DAILY.fetch('https://online-daily.internal/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({at})});
  data=await response.json<any>();
  if(!response.ok||!data.ok||data.state!=='sent')throw Error('online-daily source review/delivery not confirmed');
 } catch(error) {
  await saveBoardReceipt(env.ORG_DB,at,null,'получение результата или доставка не завершены');
  throw error;
 }
 await saveBoardReceipt(env.ORG_DB,at,data);
 if(!data.complete)throw Error(`Telegram ${data.message_id} delivered; source coverage partial — gaps in report`);
 return {rows:1,note:`Telegram ${data.message_id}; source coverage complete`};
});
export default {
 scheduled:timer.scheduled,
 async fetch(request:Request,env:Env,ctx:ExecutionContext){
  if(new URL(request.url).pathname!=='/preview')return timer.fetch(request,env,ctx);
  const given=(request.headers.get('Authorization')??'').replace(/^Bearer\s+/i,'');const secret=env.ERP_RUN_SECRET??'';
  let diff=given.length^secret.length;for(let i=0;i<secret.length;i++)diff|=secret.charCodeAt(i)^(given.charCodeAt(i)||0);
  if(!secret||diff)return Response.json({ok:false},{status:401});
  return env.ONLINE_DAILY.fetch('https://online-daily.internal/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({at:Date.now(),preview:true})});
 }
};
