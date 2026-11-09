// Protected Diana helper. Reviewed original-message facts on stdin; no sending or payment.
import {pathToFileURL} from 'node:url';
import {protectedReviewDatabase} from './ugc-content-review.mjs';
import {prepareCreatorPayout} from '../api/src/lib/ugc-payout-intake.ts';
export async function protectedPayoutIntake(input,{token,fetchImpl=fetch}) {
  if(!token) throw Error('existing_protected_credential_required');
  return prepareCreatorPayout({DB:protectedReviewDatabase({token,fetchImpl})},input);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try {let input='';for await(const part of process.stdin){input+=part;if(input.length>16000)throw Error('intake_input_too_large');}
    console.log(JSON.stringify({ok:true,...await protectedPayoutIntake(JSON.parse(input),{token:process.env.CLOUDFLARE_API_TOKEN})}));
  } catch(error){console.error(JSON.stringify({ok:false,error:error instanceof Error?error.message:'payout_intake_failed'}));process.exitCode=1;}
}
