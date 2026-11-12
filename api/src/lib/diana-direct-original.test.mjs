import test from 'node:test';
import assert from 'node:assert/strict';
import {readDirectOriginal} from './diana-direct-original.mjs';

test('reads the original conversation in memory and follows original message pages', async()=>{
  const seen=[];
  const result=await readDirectOriginal({conversationId:'chat',messageId:'m2',token:'fixture',fetchImpl:async url=>{
    seen.push(url);
    if(url.includes('fields=access_token')) return Response.json({access_token:'page-fixture'});
    if(url.includes('&after=')) return Response.json({data:[{id:'m1',from:{id:'creator'},message:'older'}]});
    return Response.json({data:[{id:'m2',from:{id:'creator'},message:'new',attachments:{data:[{mime_type:'image/jpeg'}]}}],paging:{next:'yes',cursors:{after:'cursor'}}});
  }});
  assert.equal(result.status,'ready');assert.deepEqual(result.messages.map(m=>m.id),['m1','m2']);assert.equal(seen.length,3);
});
test('does not act on a signal whose last message changed or is ours',async()=>{
  for(const latest of [{id:'new',from:{id:'creator'}},{id:'m',from:{id:'17841466350261166'}}]){
    const r=await readDirectOriginal({conversationId:'chat',messageId:'m',token:'fixture',fetchImpl:async url=>url.includes('fields=access_token')?Response.json({access_token:'page'}):Response.json({data:[latest]})});
    assert.deepEqual(r,{status:'superseded'});
  }
});
test('incomplete pagination and failed Meta requests are not mistaken for complete history',async()=>{
  await assert.rejects(readDirectOriginal({conversationId:'chat',messageId:'m',token:'fixture',fetchImpl:async url=>url.includes('fields=access_token')?Response.json({access_token:'page'}):Response.json({data:[],paging:{next:'yes',cursors:{after:'x'}}})}),/direct_original_incomplete/);
  await assert.rejects(readDirectOriginal({conversationId:'chat',messageId:'m',token:'fixture',fetchImpl:async()=>new Response('',{status:503})}),/direct_original_http_503/);
});
test('an empty «unsupported» message is asked again by its own id and gets its picture back',async()=>{
  const r=await readDirectOriginal({conversationId:'chat',messageId:'m3',token:'fixture',fetchImpl:async url=>{
    if(url.includes('fields=access_token'))return Response.json({access_token:'page'});
    if(url.includes('/m1?'))return Response.json({id:'m1',attachments:{data:[{image_data:{url:'https://x/cart'}}]}});
    if(url.includes('/m3?'))return Response.json({id:'m3'});
    return Response.json({data:[{id:'m3',from:{id:'creator'},message:''},{id:'m2',from:{id:'creator'},message:'сбер озон'},{id:'m1',from:{id:'creator'},message:'',is_unsupported:true}]});
  }});
  assert.equal(r.status,'ready');
  assert.equal(r.messages[0].attachments.data[0].image_data.url,'https://x/cart');assert.equal(r.messages[0].is_unsupported,undefined);
  assert.equal(r.messages[2].attachments,undefined);
});
