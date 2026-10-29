import { subscriptionInference } from './diana-subscription-transport.mjs';
export function subscriptionInfer(env, operation) {
 return async(messages,{model='gpt-6-luna',schema}={})=>{
  const input=JSON.stringify({operation,model,messages,schema});
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(input)))].map(v=>v.toString(16).padStart(2,'0')).join('');
  return subscriptionInference(messages,{binding:env.DIANA_SUBSCRIPTION,operation,model,schema,requestId:`${operation}-${hash}`});
 };
}
