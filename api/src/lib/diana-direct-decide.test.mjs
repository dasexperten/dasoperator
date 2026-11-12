import test from 'node:test';
import assert from 'node:assert/strict';
import {decideDirect} from './diana-direct-decide.mjs';
const source=()=>({status:'ready',messageId:'m1',messages:[{id:'m1',from:{id:'creator'},message:'Hello'}]});
function env(){const calls=[];return {calls,options:{source:source(),env:{GITHUB_TOKEN:'fixture'},prepareContext:async({task})=>({system:'Diana profile',receipt:{source:'fixture'},task}),infer:async(messages,options)=>{calls.push({messages,options});return {text:JSON.stringify({action:'reply',reply:'Здравствуйте!'})};},readImage:async()=>({mediaType:'image/png',data:'YQ=='})}};}
test('uses current profile and transient conversation to create a reply decision',async()=>{const f=env();const d=await decideDirect(f.options);assert.equal(d.action,'reply');assert.equal(d.recipientId,'creator');assert.match(f.calls[0].messages[1].content,/Hello/);});
test('payout decision never returns a reply or invents a completed handoff',async()=>{const f=env();f.options.infer=async()=>({text:JSON.stringify({action:'payout',reply:null})});const d=await decideDirect(f.options);assert.equal(d.reply,undefined);assert.equal(d.amountQuestion,null);delete d.amountQuestion;delete d.recipientId;assert.deepEqual(d,{action:'payout',reason:'payout_handoff_pending',receipt:{images_read:0,images_uncertain:0,images_unavailable:0,image_diagnostics:{download_failed:0,download_missing:0,model_failed:0,model_uncertain:0},image_trace:[]}});});
test('current video remains pending rather than guessed',async()=>{const f=env();f.options.source.messages[0].attachments={data:[{mime_type:'video/mp4'}]};assert.equal((await decideDirect(f.options)).action,'wait');});
test('unavailable image is disclosed to Diana while readable text continues',async()=>{const f=env();f.options.source.messages[0].attachments={data:[{mime_type:'image/png'}]};await decideDirect(f.options);assert.match(f.calls[0].messages[1].content,/unavailable_images/);});
test('reads screenshots from earlier incoming messages when the latest message is text',async()=>{const f=env();f.options.source.messages.unshift({id:'older',from:{id:'creator'},attachments:{data:[{mime_type:'image/png',image_data:{url:'https://example.invalid'}}]}});f.options.infer=async(messages,options)=>{f.calls.push({messages,options});return {text:JSON.stringify(options.model==='gpt-6-luna'?{visible_text:'394 rubles',uncertain:false}:{action:'reply',reply:'Спасибо!'})};};await decideDirect(f.options);assert.match(f.calls[1].messages[1].content,/394 rubles/);assert.match(f.calls[1].messages[1].content,/older/);});
test('reads a current image with Luna and supplies only transient transcription to the reply',async()=>{const f=env();f.options.source.messages[0].attachments={data:[{mime_type:'image/png',image_data:{url:'https://example.invalid'}}]};f.options.infer=async(messages,options)=>{f.calls.push({messages,options});return {text:JSON.stringify(options.model==='gpt-6-luna'?{visible_text:'visible original',uncertain:false}:{action:'reply',reply:'Спасибо!'})};};const out=await decideDirect(f.options);assert.equal(out.action,'reply');assert.equal(f.calls[0].options.model,'gpt-6-luna');assert.match(f.calls[1].messages[1].content,/visible original/);});
test('an invalid model decision cannot produce an outgoing message',async()=>{const f=env();f.options.infer=async()=>({text:'{"action":"reply","reply":null}'});await assert.rejects(decideDirect(f.options),/direct_decision_invalid/);});
test('immediately tries Terra if Luna cannot read an image',async()=>{
 const f=env();f.options.source.messages[0].attachments={data:[{mime_type:'image/png',image_data:{url:'https://example.invalid'}}]};
 f.options.infer=async(messages,options)=>{f.calls.push({messages,options});if(options.model==='gpt-6-luna')throw Error('image error');return {text:JSON.stringify(f.calls.length===2?{visible_text:'read by Terra',uncertain:false}:{action:'reply',reply:'Спасибо!'})};};
 await decideDirect(f.options);assert.deepEqual(f.calls.map(c=>c.options.model),['gpt-6-luna','gpt-6.1-terra','gpt-6.1-terra']);assert.match(f.calls[2].messages[1].content,/read by Terra/);
});
test('multiple original screenshots are read concurrently and in message order',async()=>{
 const f=env();f.options.source.messages.unshift(...['a','b','c'].map(id=>({id,from:{id:'creator'},attachments:{data:[{mime_type:'image/png',image_data:{url:'https://example.invalid/'+id}}]}})));
 let active=0,peak=0;f.options.infer=async(messages,options)=>{if(options.model==='gpt-6-luna'){active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,5));active--;return {text:JSON.stringify({visible_text:'seen',uncertain:false})};}return {text:JSON.stringify({action:'reply',reply:'Спасибо!'})};};
 const out=await decideDirect(f.options);assert.equal(peak,3);assert.equal(out.receipt.images_read,3);
});
test('passes a partially legible screenshot with uncertainty after both models try it',async()=>{
 const f=env();f.options.source.messages[0].attachments={data:[{mime_type:'image/png',image_data:{url:'https://example.invalid'}}]};
 f.options.infer=async(messages,options)=>{f.calls.push({messages,options});if(f.calls.length<=2)return {text:JSON.stringify({visible_text:'Seller: Das Experten',uncertain:true})};return {text:JSON.stringify({action:'reply',reply:'Спасибо!'})};};
 const out=await decideDirect(f.options);assert.equal(out.receipt.images_read,1);assert.equal(out.receipt.images_uncertain,1);assert.match(f.calls[2].messages[1].content,/Seller: Das Experten/);assert.match(f.calls[2].messages[1].content,/uncertain/);assert.match(f.calls[2].messages[0].content,/do not treat uncertain amounts/);
});

test('leaves a proof trace of every image read without keeping any text',async()=>{const f=env();f.options.source.messages[0].attachments={data:[{mime_type:'image/png',image_data:{url:'https://example.invalid'}}]};f.options.infer=async(m,o)=>({text:JSON.stringify(o.model==='gpt-6-luna'?{visible_text:'Card 4276 amount 394',uncertain:false}:{action:'reply',reply:'Спасибо!'})});const d=await decideDirect(f.options);const [t]=d.receipt.image_trace;assert.equal(d.receipt.image_trace.length,1);assert.equal(t.message_id,'m1');assert.equal(t.sha256,'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb');assert.equal(t.model,'gpt-6-luna');assert.equal(t.read,true);assert.equal(t.uncertain,false);assert.equal(t.version,'direct-vision-1');assert.ok(!JSON.stringify(d.receipt).includes('4276'));});

test('Owner 2026-11-12 anyanapanike: a blank collab message is matched to her reel, never «не могу разобрать»',async()=>{
 const {decideDirect}=await import('./diana-direct-decide.mjs');let seen=null;
 const source={status:'ready',messageId:'m3',messages:[{id:'m1',from:{id:'17841466350261166'},message:'Когда ролик?',created_time:'2026-11-12T04:40:00Z'},{id:'m3',from:{id:'u9',username:'anya'},message:'',is_unsupported:true,created_time:'2026-11-12T04:48:59Z'}]};
 const out=await decideDirect({source,prepareContext:async()=>({system:'DIANA',receipt:{}}),readImage:async()=>null,env:{},
  infer:async(m)=>{seen=JSON.parse(m[1].content);return{text:JSON.stringify({action:'reply',reply:'Аня, спасибо за ролик!'})};},
  lookupPublication:async({handle})=>({kind:'invite',accepted:true,permalink:null,caption:'паста с термо эффектом'})});
 assert.equal(out.action,'reply');assert.equal(seen.verified_erp_facts.verified_publication.kind,'invite');assert.equal(seen.unavailable_images,0);
});
