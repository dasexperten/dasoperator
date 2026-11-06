import test from 'node:test';
import assert from 'node:assert/strict';
import { selectWithSubscription } from './diana-subscription-selection.mjs';

test('every candidate crosses batch boundaries with its complete text', async () => {
  const candidates = Array.from({length:257}, (_,i)=>({key:`key${i}`,heading:`heading${i}`,description:'x'.repeat(9000)+i}));
  const seen=[];
  const picked=await selectWithSubscription('task',candidates,{infer:async messages=>{
    const data=JSON.parse(messages[1].content);seen.push(...data.candidates);
    return {text:JSON.stringify({scores:Object.fromEntries(data.candidates.map(c=>[c.id,0.8]))})};
  }});
  assert.equal(seen.length,257);
  assert.deepEqual(seen.map(c=>c.description),candidates.map(c=>c.description));
  assert.deepEqual(picked.map(c=>c.key),candidates.map(c=>c.key));
});
test('missing, legacy array, extra, mistyped or out-of-range scores fail closed',async()=>{
  for(const scores of [{},[],{c0:.8},{c0:.8,c2:.8},{c0:'0.8',c1:.8},{c0:2,c1:.8}]) {
    await assert.rejects(selectWithSubscription('task',[{key:'a'},{key:'b'}],{infer:async()=>({text:JSON.stringify({scores})})}),/candidate/);
  }
});
test('provider failure has no fallback and zero scores are not promoted',async()=>{
  let calls=0;
  await assert.rejects(selectWithSubscription('task',[{key:'a'}],{infer:async()=>{calls++;throw Error('subscription unavailable');}}),/subscription unavailable/);
  assert.equal(calls,1);
  assert.deepEqual(await selectWithSubscription('task',[{key:'a'}],{infer:async()=>({text:'{"scores":{"c0":0}}'})}),[]);
  await assert.rejects(selectWithSubscription('task',[{key:'a'}],{}),/transport missing/);
});


test('native schema requires every candidate ID and rejects extra keys',async()=>{
  await selectWithSubscription('task',[{key:'a'},{key:'b'}],{infer:async(messages,{schema})=>{
    assert.deepEqual(schema.properties.scores.required,['c0','c1']);
    assert.equal(schema.properties.scores.additionalProperties,false);
    assert.deepEqual(schema.properties.scores.properties.c0,{type:'number',minimum:0,maximum:1});
    assert.deepEqual(Object.keys(schema.properties.scores.properties),['c0','c1']);
    return {text:JSON.stringify({scores:{c0:0.24,c1:0.25}})};
  }}).then(picked=>assert.deepEqual(picked.map(c=>c.key),['b']));
});
