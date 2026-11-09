import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {payoutCell,canPay,canSetPayoutAmount} from './ugc-payout-cell.mjs';

// Execute the actual badge and its click handler, without loading the full page.
const page=readFileSync(new URL('../app/ugc/page.tsx',import.meta.url),'utf8');
const component=page.slice(page.indexOf('function PayoutBadge('),page.indexOf('// «Сеть»'));
const js=ts.transpileModule(component,{compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2022}}).outputText;
function harness(isAdmin=true,answer='453'){
 const calls={patch:[],pay:[],reload:[],review:[]};
 const context={isAdmin,busy:new Set(),errors:{},pay:p=>calls.pay.push(p.id),saveAmount:(p,creatorId,handle)=>calls.review.push({id:p.id,creatorId,handle})};
 const Badge=vm.runInNewContext(js+';PayoutBadge',{
  React:{createElement:(type,props,...children)=>({type,props,children})},
  useContext:()=>context,PayContext:{},payoutCell,canPay,canSetPayoutAmount,payoutTitle:()=> 'test payout',
  NoticeChip:()=>null,Loader2:()=>null,Event,
  apiPatch:async(path,body)=>{calls.patch.push({path,body});return{success:true};},
  window:{prompt:()=>answer,dispatchEvent:e=>calls.reload.push(e.type)},
 });
 const buttons=node=>!node||typeof node!=='object'?[]:[...(node.type==='button'?[node]:[]),...(node.children??[]).flatMap(buttons)];
 return{calls,buttons:p=>buttons(Badge({payout:p,creatorId:'creator-fixture',handle:'test_creator'}))};
}
const open={id:'fixture',handle:'test_creator',status:'awaiting_approval',amount_minor:1,has_requisites:1};

test('Admin opens exact payout save-only review without PATCH or payment',async()=>{
 const h=harness();const [button]=h.buttons(open);
 assert.match(button.props['aria-label'],/^Сохранить сумму/);
 await button.props.onClick({stopPropagation(){}});
 assert.equal(h.calls.patch.length,0);assert.equal(h.calls.pay.length,0);
 assert.equal(h.calls.review.length,1);
 assert.equal(h.calls.review[0].id,'fixture');assert.equal(h.calls.review[0].creatorId,'creator-fixture');
});
test('a confirmed amount keeps the existing payment action',async()=>{
 const h=harness();const [button]=h.buttons({...open,amount_minor:45300});
 assert.match(button.props['aria-label'],/^Оплатить:/);
 await button.props.onClick({stopPropagation(){}});
 assert.deepEqual(h.calls.pay,['fixture']);assert.equal(h.calls.patch.length,0);
});
test('non-admin, settled and claimed rows never offer amount editing',()=>{
 assert.equal(harness(false).buttons(open).length,0);
 for(const change of [{status:'sent'},{status:'paid'},{status:'failed'},{execute_claim:'held'},{konsol_payment_id:'existing'}]){
  assert.equal(harness().buttons({...open,...change}).length,0);
 }
});
test('held known amounts never offer payment or amount editing',()=>{
 assert.equal(harness().buttons({...open,amount_minor:45300,payout_hold:true}).length,0);
});
