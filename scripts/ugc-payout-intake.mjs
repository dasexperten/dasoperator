// Protected Diana helper. Reviewed original-message facts on stdin; no sending or payment.
import {pathToFileURL} from 'node:url';
import {protectedReviewDatabase} from './ugc-content-review.mjs';
import {incomingAmount} from '../api/src/lib/ugc-cart-decision.mjs';
import {prepareCreatorPayout} from '../api/src/lib/ugc-payout-intake.ts';
export async function protectedPayoutIntake(input,{token,fetchImpl=fetch}) {
  if(!token) throw Error('existing_protected_credential_required');
  const DB=protectedReviewDatabase({token,fetchImpl});
  if(input.source_recheck===true){
    const messages=(await DB.prepare('SELECT id,direction,text,created_at,attachments_json FROM ugc_ig_messages WHERE conversation_id=?1 ORDER BY created_at DESC LIMIT 500').bind(input.conversation_id).all()).results;
    const quote=incomingAmount(messages);
    const latestImage=messages.filter(m=>m.direction==='in'&&m.attachments_json&&!['[]','{}','null',''].includes(m.attachments_json)).sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at))[0];
    if(!quote?.explicit||!quote.amount_minor||(latestImage&&Date.parse(quote.created_at)<=Date.parse(latestImage.created_at)))throw Error('source_quote_not_explicit_current');
    const latestIncoming=messages.filter(m=>m.direction==='in').sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at))[0];
    const receipt={version:1,conversation_id:input.conversation_id,latest_image_at:latestImage?.created_at??null,latest_incoming_at:latestIncoming?.created_at??null,status:'confirmed',authority:'incoming_text',source_message_id:quote.source_message_id,amount_minor:quote.amount_minor,checks:[],quote,checked_at:Date.now()};
    await DB.batch([DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind('ugc_cart_review:'+input.conversation_id,JSON.stringify(receipt),Date.now())]);
    input={...input,amount_minor:quote.amount_minor};
  }
  return prepareCreatorPayout({DB},input);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try {let input='';for await(const part of process.stdin){input+=part;if(input.length>16000)throw Error('intake_input_too_large');}
    console.log(JSON.stringify({ok:true,...await protectedPayoutIntake(JSON.parse(input),{token:process.env.CLOUDFLARE_API_TOKEN})}));
  } catch(error){console.error(JSON.stringify({ok:false,error:error instanceof Error?error.message:'payout_intake_failed'}));process.exitCode=1;}
}
