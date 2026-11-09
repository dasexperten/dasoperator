import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {payoutCell,canPay} from './ugc-payout-cell.mjs';

// Execute the actual badge and its click handler, without loading the full page.
const page=readFileSync(new URL('../app/ugc/page.tsx',import.meta.url),'utf8');
const component=page.slice(page.indexOf('function PayoutBadge('),page.indexOf('// «Сеть»'));
const js=ts.transpileModule(component,{compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2022}}).outputText;
function harness(isAdmin=true,answer='453'){
 const calls={patch:[],pay:[],reload:[]};
 const context={isAdmin,busy:new Set(),errors:{},pay:p=>calls.pay.push(p.id)};
 const Badge=vm.runInNewContext(js+';PayoutBadge',{
  React:{createElement:(type,props,...children)=>({type,props,children})},
  useContext:()=>context,PayContext:{},payoutCell,canPay,payoutTitle:()=> 'test payout',
  NoticeChip:()=>null,Loader2:()=>null,Event,
  apiPatch:async(path,body)=>{calls.patch.push({path,body});return{success:true};},
  window:{prompt:()=>answer,dispatchEvent:e=>calls.reload.push(e.type)},
 });
 const buttons=node=>!node||typeof node!=='object'?[]:[...(node.type==='button'?[node]:[]),...(node.children??[]).flatMap(buttons)];
 return{calls,buttons:p=>buttons(Badge({payout:p}))};
}
const open={id:'fixture',handle:'test_creator',status:'awaiting_approval',amount_minor:1,has_requisites:1};

test('Admin can enter a missing amount without attempting payment',async()=>{
 const h=harness();const [button]=h.buttons(open);
 assert.match(button.props['aria-label'],/^Указать сумму:/);
 await button.props.onClick({stopPropagation(){}});
 assert.equal(h.calls.patch.length,1);
 assert.equal(h.calls.patch[0].body.amount_rub,453);
 assert.equal(h.calls.patch[0].path,'/api/ugc/payouts/fixture');
 assert.equal(h.calls.pay.length,0);
 assert.deepEqual(h.calls.reload,['ugc:reload']);
});
test('a confirmed amount keeps the existing payment action',async()=>{
 const h=harness();const [button]=h.buttons({...open,amount_minor:45300});
 assert.match(button.props['aria-label'],/^Оплатить:/);
 await button.props.onClick({stopPropagation(){}});
 assert.deepEqual(h.calls.pay,['fixture']);assert.equal(h.calls.patch.length,0);
});
test('manual amount entry preserves kopecks instead of rounding to whole roubles',async()=>{
 const h=harness(true,'453,50');
 await h.buttons(open)[0].props.onClick({stopPropagation(){}});
 assert.equal(h.calls.patch[0].body.amount_rub,453.5);
 assert.equal(h.calls.pay.length,0);
});
test('non-admin, settled and claimed rows never offer amount editing',()=>{
 assert.equal(harness(false).buttons(open).length,0);
 for(const change of [{status:'sent'},{status:'paid'},{status:'failed'},{execute_claim:'held'},{konsol_payment_id:'existing'}]){
  assert.equal(harness().buttons({...open,...change}).length,0);
 }
});
test('cancelled or invalid amount input makes no change and no payment',async()=>{
 for(const answer of [null,'','0','49','1000']){
  const h=harness(true,answer);await h.buttons(open)[0].props.onClick({stopPropagation(){}});
  assert.equal(h.calls.patch.length,0);assert.equal(h.calls.pay.length,0);
 }
});
