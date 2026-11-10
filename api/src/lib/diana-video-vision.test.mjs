import test from 'node:test';import assert from 'node:assert/strict';import {checkVideoFrames} from './diana-video-vision.mjs';
const frame={mediaType:'image/jpeg',data:'ZmFrZQ==',label:'source frame'};
const result={kind:'other',product:'unknown',seller:'unknown',amount:'unknown',seller_evidence:'absent',what:'other',visible_text:'',observed:{product_name:null,price:null,currency:null,payment_status:null,delivery_status:null,seller_name:null},requisites:{holder_name:null,bank:null,phone:null,card:null,amount:null,currency:null},unresolved_required:[]};
test('batches Luna frames, retaining exact mapping, and retries only incomplete payment frame',async()=>{
 const calls=[];const infer=async(messages,{model})=>{calls.push({model,images:messages[0].images});if(model==='gpt-6.1-terra')return{text:JSON.stringify({...result,unresolved_required:[]})};return{text:JSON.stringify({frames:messages[0].images.map((_,index)=>({index,result:{...result,unresolved_required:index===1&&calls.length===1?['phone']:[]}}))})};};
 const r=await checkVideoFrames({images:Array.from({length:8},(_,i)=>({...frame,label:'source '+i})),policy:{},task:'video',infer});
 assert.equal(r.checks.length,8);assert.deepEqual(calls.map(x=>x.model),['gpt-6-luna','gpt-6.1-terra','gpt-6-luna']);assert.equal(calls[1].images.length,1);assert.equal(calls[1].images[0].label,'source 1');
});
test('duplicate or missing batch indices fail closed',async()=>{
 const infer=async()=>({text:JSON.stringify({frames:[{index:0,result},{index:0,result}]})});
 await assert.rejects(checkVideoFrames({images:[frame,frame],policy:{},task:'video',infer}),/mapping_invalid/);
});
