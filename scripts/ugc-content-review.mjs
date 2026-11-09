// Dedicated adapter for Diana's already-authorised protected round helper.
// The helper passes its existing D1 credential in the environment, never in
// argv/output. This adds no service grant, login or generic SQL execution door.
// Node 24: JSON {id,verdict,evidence,author_verified,our_product,published_at?} on stdin.
import {pathToFileURL} from 'node:url';
import {reviewContent} from '../api/src/lib/ugc-content-review.ts';
export function protectedReviewDatabase({token,fetchImpl=fetch}) {
  const endpoint='https://api.cloudflare.com/client/v4/accounts/081ddb85cb399ad62a70210328d744fc/d1/database/0653d156-5069-4c46-a496-fad982d0d1df/query';
  async function execute(body){
    const response=await fetchImpl(endpoint,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
    if(!response.ok)throw Error(`review_storage_http_${response.status}`);
    const out=await response.json();if(!out.success||!Array.isArray(out.result)||out.result.some(r=>!r.success))throw Error('review_storage_failed');return out.result;
  }
  return {prepare(sql){let params=[];const q={bind(...p){params=p;return q;},get statement(){return {sql,params};},async first(){return (await execute({sql,params}))[0].results?.[0]??null;},async all(){return{results:(await execute({sql,params}))[0].results??[]};}};return q;},
    async batch(statements){return execute({batch:statements.map(q=>q.statement)});}};
}
export async function protectedContentReview(input,{token,fetchImpl=fetch}) {
  if(!token)throw Error('existing_protected_credential_required');
  if(typeof input.id!=='string'||!input.id.trim())throw Error('content_id_required');
  return reviewContent({DB:protectedReviewDatabase({token,fetchImpl})},input.id,input);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{let text='';for await(const part of process.stdin){text+=part;if(text.length>6000)throw Error('review_input_too_large');}
    const result=await protectedContentReview(JSON.parse(text),{token:process.env.CLOUDFLARE_API_TOKEN});
    console.log(JSON.stringify({ok:true,...result}));
  }catch(error){console.error(JSON.stringify({ok:false,error:error instanceof Error?error.message:'review_failed'}));process.exitCode=1;}
}
