import type {Env} from '../types';
import {imageUrls,loadInstagramImage} from './ig-dm-image-cache';
import {refreshIgAttachments} from './ig-dm-watch';
import {subscriptionInfer} from './diana-subscription.mjs';
import {checkSubscriptionImages} from './diana-subscription-vision.mjs';
import {decideCart,incomingAmount} from './ugc-cart-decision.mjs';
export type CartMessage={id:string;direction:string;text?:string;created_at:string;attachments_json?:string|null};
type Policy={sha:string;policy:any};
const RECOGNITION_VERSION='ugc-cart-numeric-v2';
async function digest(value:string){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(n=>n.toString(16).padStart(2,'0')).join('');}
export async function payoutImagePolicy(env:Env):Promise<Policy>{
 const token=(env as unknown as {GITHUB_TOKEN?:string}).GITHUB_TOKEN;
 if(!token)throw Error('cart_policy_token_missing');
 const r=await fetch('https://api.github.com/repos/dasexperten/organizacia/contents/agents/diana-helios/IMAGE_RULES.json?ref=main',{headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','User-Agent':'ugc-cart-review'},signal:AbortSignal.timeout(20000)});
 if(!r.ok)throw Error('cart_policy_unavailable');
 const body=await r.json() as any;
 if(!/^[a-f0-9]{40}$/.test(body.sha??'')||body.encoding!=='base64')throw Error('cart_policy_invalid');
 const policy=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(body.content.replace(/\s/g,'')),c=>c.charCodeAt(0))));
 if(!policy.product||!Array.isArray(policy.sellers))throw Error('cart_policy_invalid');
 return{sha:body.sha,policy};
}
/** Only source images and structured subscription results enter the numeric decision.
 * Source/policy hashes deduplicate recognition. No sends, payment calls or profile context selection. */
export async function reviewPayoutCart(env:Env,cid:string,messages:CartMessage[],options:{readOnly?:boolean;budget?:{remaining:number};policy?:()=>Promise<Policy>;now?:number}={}){
 const now=options.now??Date.now(),quote=incomingAmount(messages);
 const imageMessages=messages.filter(m=>m.direction==='in'&&m.attachments_json&&m.attachments_json!=='[]'&&m.attachments_json!=='{}').sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at));
 const latestImageAt=imageMessages[0]?.created_at??null;
 const checks:any[]=[];let unavailable=false,omitted=false,policy:Policy|undefined;
 const latestExplicit=quote?.explicit&&quote.amount_minor&&(!latestImageAt||Date.parse(quote.created_at)>Date.parse(latestImageAt));
 for(const m of (latestExplicit?[]:imageMessages.slice(0,6))){
  let urls:string[]=[];try{urls=imageUrls(m.attachments_json!);}catch{unavailable=true;continue;}
  for(const [index,originalUrl] of urls.entries()){
   policy??=await (options.policy?.()??payoutImagePolicy(env));
   const key='ugc_cart_image:'+await digest(m.id+':'+index+':'+policy.sha+':'+RECOGNITION_VERSION);
   const cached=options.readOnly?null:await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind(key).first<{value:string}>();
   let check:any;try{check=cached?JSON.parse(cached.value):null;}catch{}
   if(check?.retry_at&&check.retry_at<=now)check=null;
   if(!check){
    if(options.budget&&options.budget.remaining<=0){omitted=true;continue;}
    if(options.budget)options.budget.remaining--;
    try{
     let image;try{image=await loadInstagramImage(env,m.id,index,originalUrl);}catch{
      const fresh=await refreshIgAttachments(env,m.id),url=fresh?imageUrls(fresh)[index]:null;if(!url)throw Error('image_unavailable');image=await loadInstagramImage(env,m.id,index,url);
     }
     const hash=await digest(image.data);
     const result=await checkSubscriptionImages({images:[{...image,label:`Скриншот из входящего сообщения ${m.created_at}, вложение ${index+1}.`}],policy:policy.policy,
      task:'Determine the current RUB payable amount for ONE programme TERMO toothpaste, using only this original image. A checkout BEFORE placing the order is a basket. Other unselected goods and their totals are not our reimbursement. Prefer the selected payment method total for this programme item. Transcribe price without arbitrary digits. Seller-only screens are other, not a new basket. Do not infer a price from product cards, old crossed-out prices, instalments, credit limits or text outside the image.',infer:subscriptionInfer(env,'image')});
     const c=result.checks[0]!;
     check={source_message_id:m.id,created_at:m.created_at,attachment_index:index,encoded_image_sha256:hash,policy_sha:policy.sha,recognition_version:RECOGNITION_VERSION,kind:c.kind,source_kind:(c as any).source_kind??c.kind,product:c.product,seller:c.seller,amount:c.amount,observed:c.observed,unresolved_required:(c as any).unresolved_required??[],attempts:c.attempts,checked_at:now};
    }catch{check={source_message_id:m.id,created_at:m.created_at,attachment_index:index,kind:'unknown',product:'unknown',seller:'unknown',amount:'unknown',reason:'recognition_pending',retry_at:now+5*60000};}
    if(!options.readOnly)await env.DB.batch([env.DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind(key,JSON.stringify(check),now)]);
   }
   checks.push(check);
  }
  // A recognised latest basket is sufficient; older pictures cannot supply a different price.
  if(checks.some(c=>c.source_message_id===m.id&&['basket','order','unknown'].includes(c.kind)))break;
 }
 if(!latestExplicit&&imageMessages.length>6&&!checks.some(c=>c.kind==='basket'))omitted=true;
 let decision=decideCart(checks,quote);
 if(unavailable||omitted)decision={status:'pending',reason:unavailable?'image_source_unavailable':'recognition_budget_pending',amount_minor:null};
 const latestIncoming=messages.filter(m=>m.direction==='in').sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at))[0]?.created_at??null;
 const receipt={version:1,conversation_id:cid,latest_image_at:latestImageAt,latest_incoming_at:latestIncoming,source_fingerprint:await digest(JSON.stringify(messages.map(m=>[m.id,m.created_at,m.direction,m.text??'',Boolean(m.attachments_json&&m.attachments_json!=='[]'&&m.attachments_json!=='{}')]))),...decision,checks,quote,checked_at:now};
 if(!options.readOnly){
  const key='ugc_cart_review:'+cid;
  await env.DB.batch([env.DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind(key,JSON.stringify(receipt),now)]);
  const saved=await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind(key).first<{value:string}>();if(saved?.value!==JSON.stringify(receipt))throw Error('cart_receipt_readback_failed');
 }
 return receipt;
}
