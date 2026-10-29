import test from 'node:test';
import assert from 'node:assert/strict';
import { selectWithSubscription } from './diana-subscription-selection.mjs';

test('every candidate crosses batch boundaries with its complete text', async () => {
  const candidates = Array.from({length:257}, (_,i)=>({key:`key${i}`,heading:`heading${i}`,description:'x'.repeat(9000)+i}));
  const seen=[];
  const picked=await selectWithSubscription('task',candidates,{infer:async messages=>{
    const data=JSON.parse(messages[1].content);seen.push(...data.candidates);
    return {text:JSON.stringify({scores:data.candidates.map(c=>({id:c.id,score:0.8}))})};
  }});
  assert.equal(seen.length,257);
  assert.deepEqual(seen.map(c=>c.description),candidates.map(c=>c.description));
  assert.deepEqual(picked.map(c=>c.key),candidates.map(c=>c.key));
});
test('missing, duplicate, extra, mistyped or out-of-range scores fail closed',async()=>{
  for(const scores of [[],[{id:'c0',score:.8},{id:'c0',score:.8}],[{id:'c0',score:.8},{id:'c2',score:.8}],[{id:'c0',score:'0.8'},{id:'c1',score:.8}],[{id:'c0',score:2},{id:'c1',score:.8}]]) {
    await assert.rejects(selectWithSubscription('task',[{key:'a'},{key:'b'}],{infer:async()=>({text:JSON.stringify({scores})})}),/candidate/);
  }
});
test('provider failure has no fallback and zero scores are not promoted',async()=>{
  let calls=0;
  await assert.rejects(selectWithSubscription('task',[{key:'a'}],{infer:async()=>{calls++;throw Error('subscription unavailable');}}),/subscription unavailable/);
  assert.equal(calls,1);
  assert.deepEqual(await selectWithSubscription('task',[{key:'a'}],{infer:async()=>({text:'{"scores":[{"id":"c0","score":0}]}'})}),[]);
  await assert.rejects(selectWithSubscription('task',[{key:'a'}],{}),/transport missing/);
});
