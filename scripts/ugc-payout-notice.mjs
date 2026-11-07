// Node 24; original-message proof JSON on stdin. Existing protected credential
// stays in the process environment. No payment or message send is performed.
import {pathToFileURL} from 'node:url';
import {protectedReviewDatabase} from './ugc-content-review.mjs';
import {recordPayoutNotice} from '../api/src/lib/ugc-payout-notice.ts';
export async function protectedPayoutNotice(input,{token,fetchImpl=fetch}) {
  if(!token)throw Error('existing_protected_credential_required');
  if(typeof input.id!=='string'||!input.id.trim())throw Error('payout_id_required');
  return recordPayoutNotice({DB:protectedReviewDatabase({token,fetchImpl})},input.id,input);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{let text='';for await(const part of process.stdin){text+=part;if(text.length>6000)throw Error('notice_input_too_large');}
    console.log(JSON.stringify({ok:true,...await protectedPayoutNotice(JSON.parse(text),{token:process.env.CLOUDFLARE_API_TOKEN})}));
  }catch(error){console.error(JSON.stringify({ok:false,error:error instanceof Error?error.message:'notice_verification_failed'}));process.exitCode=1;}
}
