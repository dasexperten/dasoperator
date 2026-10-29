import { Container } from '@cloudflare/containers';
import { WorkerEntrypoint } from 'cloudflare:workers';
const enc=new TextEncoder();
async function key(secret){return crypto.subtle.importKey('raw',Uint8Array.from(atob(secret),c=>c.charCodeAt(0)),{name:'AES-GCM'},false,['encrypt','decrypt']);}
async function seal(value,secret){const iv=crypto.getRandomValues(new Uint8Array(12));const data=await crypto.subtle.encrypt({name:'AES-GCM',iv},await key(secret),enc.encode(JSON.stringify(value)));return {iv:[...iv],data:[...new Uint8Array(data)]};}
async function unseal(value,secret){return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(value.iv)},await key(secret),new Uint8Array(value.data))));}
export class CodexRunner extends Container {
 defaultPort=8080;sleepAfter='5m';queue=Promise.resolve();
 async seed(auth){return this.serial(async()=>{if(await this.ctx.storage.get('auth'))throw Error('auth_already_seeded');if(auth?.auth_mode!=='chatgpt'||!auth.tokens?.refresh_token)throw Error('managed_chatgpt_auth_required');await this.ctx.storage.put('auth',await seal(auth,this.env.AUTH_KEY));return {seeded:true};});}
 serial(fn){const result=this.queue.then(fn);this.queue=result.catch(()=>{});return result;}
 async infer(body){return this.serial(async()=>{
  if(!body.requestId||!['image','context'].includes(body.operation)||!['gpt-6-luna','gpt-6.1-terra'].includes(body.model))return Response.json({error:'invalid_request'},{status:400});
  const fingerprint=[...new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(JSON.stringify(body))))].map(x=>x.toString(16).padStart(2,'0')).join('');
  const cacheKey='result:'+body.requestId;const previous=await this.ctx.storage.get(cacheKey);
  if(previous){if(previous.fingerprint!==fingerprint)return Response.json({error:'request_id_conflict'},{status:409});return Response.json(previous.result);}
  const encrypted=await this.ctx.storage.get('auth');if(!encrypted)return Response.json({error:'subscription_auth_not_seeded'},{status:503});
  const auth=await unseal(encrypted,this.env.AUTH_KEY);
  const response=await this.containerFetch(new Request('http://container/infer',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,auth})}),8080);
  if(!response.ok)return Response.json({error:'native_runner_unavailable'},{status:503});
  const result=await response.json();
  // Persist native refresh before returning. Never expose the credential to callers.
  if(result.auth)await this.ctx.storage.put('auth',await seal(result.auth,this.env.AUTH_KEY));
  delete result.auth;
  if(result.error)return Response.json({error:result.error},{status:503});
  await this.ctx.storage.put(cacheKey,{fingerprint,result,at:Date.now()});
  const cached=await this.ctx.storage.list({prefix:'result:'});for(const [k,v] of cached)if(v.at<Date.now()-86400000)await this.ctx.storage.delete(k);
  return Response.json(result);
 });}
}
export class InferenceService extends WorkerEntrypoint {
 async fetch(request){if(request.method!=='POST')return new Response('',{status:405});return this.env.RUNNER.getByName('subscription-singleton').infer(await request.json());}
}
export default {
 async fetch(request,env){
  if(!env.ADMIN_KEY || request.headers.get('Authorization')!==`Bearer ${env.ADMIN_KEY}`)return new Response('',{status:404});
  const runner=env.RUNNER.getByName('subscription-singleton');
  if(request.method==='POST'&&new URL(request.url).pathname==='/auth'){try{return Response.json(await runner.seed(await request.json()));}catch{return Response.json({error:'auth_seed_rejected'},{status:409});}}
  if(request.method==='POST'&&new URL(request.url).pathname==='/smoke')return runner.infer(await request.json());
  return new Response('',{status:404});
 }
};
