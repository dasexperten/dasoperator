import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { build } = require('esbuild');
const dir = mkdtempSync(join(tmpdir(), 'ig-delivery-'));
const outfile = join(dir, 'delivery.mjs');
await build({ entryPoints: [fileURLToPath(new URL('./ig-dm-delivery.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', outfile });
const { deliverIgReply, resumeIgDeliveries, acknowledgeIgDelivery, queueIgDeliveryTexts, igDeliveryKey } = await import(pathToFileURL(outfile));
rmSync(dir, { recursive: true });
const plan = () => ({ conversationId: 'conversation', incomingAt: '2026-10-23T12:00:00Z', handle: 'creator', parts: ['first', 'second', 'third'], cards: [] });
function fixture() {
  const f = { states: new Map(), sends: [], latest: '2026-10-23T12:00:00Z' };
  f.env = { DB: { prepare(sql) {
    let p;
    const query = { bind(...values) { p = values; return query; },
      async first() {
        if (sql.includes('MAX(created_at)')) return { t: f.latest };
        return f.states.has(p[0]) ? { value: f.states.get(p[0]) } : null;
      },
      async all() {
        return { results: [...f.states].map(([key,value])=>({key,value})).filter(({value})=>{
          const s=JSON.parse(value);return s.status!=='superseded' && !s.acknowledgedAt;
        }).slice(0,p[0]) };
      },
      async run() {
        if (sql.startsWith('INSERT')) {
          if (f.failCreate) throw Error('create unavailable');
          const exists=f.states.has(p[0]); if(!exists)f.states.set(p[0],p[1]);
          return { success:true,meta:{changes:exists?0:1} };
        }
        if (sql.startsWith('UPDATE')) {
          const next=JSON.parse(p[1]);
          if(f.failIntent && next.items.some(x=>x.status==='sending'))throw Error('intent unavailable');
          if(f.failReceipt && next.items.some(x=>x.messageId))throw Error('receipt unavailable');
          if(f.failBrowserComplete && next.status==='browser')throw Error('handoff unavailable');
          if(f.states.get(p[0])!==p[3])return {success:true,meta:{changes:0}};
          f.states.set(p[0],p[1]);
          if(f.loseAck && next.items.some(x=>x.messageId)){f.loseAck=false;throw Error('Network connection lost');}
          return {success:true,meta:{changes:1}};
        }
        throw Error('Unexpected SQL '+sql);
      }
    };return query;
  } } };
  f.send=async(_env,handle,text,opts)=>{
    f.sends.push({handle,text,...opts});
    const value=f.answers?.length?f.answers.shift():{ok:true,messageId:'mid-'+f.sends.length};
    if(value instanceof Error)throw value;
    return value;
  };
  f.state=()=>JSON.parse([...f.states.values()][0]);
  f.expire=()=>{for(const [key,raw]of f.states){const s=JSON.parse(raw);s.leaseUntil=0;f.states.set(key,JSON.stringify(s));}};
  return f;
}

test('part two rejection stays pending and resumes only the unsent fixed suffix', async()=>{
  const f=fixture();f.answers=[{ok:true,messageId:'first-id'},{ok:false,delivery:'not_sent',error:'rate limited'}];
  const first=await deliverIgReply(f.env,plan(),f.send);
  assert.equal(first.status,'pending');assert.equal(first.sent,1);assert.equal(f.state().items[0].messageId,'first-id');
  const second=await deliverIgReply(f.env,{...plan(),parts:['different model draft']},f.send);
  assert.equal(second.status,'complete');assert.equal(second.sent,3);assert.ok(f.state().completedAt>0);
  assert.deepEqual(f.sends.map(x=>x.text),['first','second','second','third']);
});
test('partial scenario cards resume only missing images and preserve each receipt', async()=>{
  const f=fixture();const p={...plan(),parts:['choose'],cards:['card1','card2','card3','card4']};
  f.answers=[{ok:true,messageId:'text-id'},{ok:true,messageId:'card1-id'},{ok:false,delivery:'not_sent',error:'rejected'}];
  const first=await deliverIgReply(f.env,p,f.send);assert.equal(first.status,'pending');assert.equal(first.sent,2);
  const [done]=await resumeIgDeliveries(f.env,f.send);assert.equal(done.status,'complete');assert.equal(done.sent,5);
  assert.deepEqual(f.sends.map(x=>x.imageUrl??x.text),['choose','card1','card2','card2','card3','card4']);
  assert.ok(f.state().items.every(x=>x.messageId));
});
test('resume selects durable delivery even after our outgoing message was archived', async()=>{
  const f=fixture();f.answers=[{ok:true,messageId:'m1'},{ok:false,delivery:'not_sent'}];
  await deliverIgReply(f.env,plan(),f.send);
  // Latest incoming stays the same; current conversation direction may now be out.
  const [done]=await resumeIgDeliveries(f.env,f.send);
  assert.equal(done.status,'complete');assert.equal(f.sends.filter(x=>x.text==='first').length,1);
});
test('ambiguous transport failure holds the plan without replay', async()=>{
  const f=fixture();f.answers=[{ok:true,messageId:'m1'},new Error('timeout')];
  assert.equal((await deliverIgReply(f.env,plan(),f.send)).status,'ambiguous');
  assert.equal((await resumeIgDeliveries(f.env,f.send))[0].status,'ambiguous');
  assert.equal(f.sends.length,2);
});
test('success without a Meta receipt cannot be counted or resent', async()=>{
  const f=fixture();f.answers=[{ok:true}];
  const r=await deliverIgReply(f.env,plan(),f.send);assert.equal(r.status,'ambiguous');assert.equal(r.sent,0);
  await resumeIgDeliveries(f.env,f.send);assert.equal(f.sends.length,1);
});
test('unpersisted receipt leaves sending intent, so another run cannot repeat it', async()=>{
  const f=fixture();f.failReceipt=true;
  const r=await deliverIgReply(f.env,plan(),f.send);assert.equal(r.status,'ambiguous');assert.equal(r.error,'delivery_receipt_not_persisted');
  assert.equal(f.state().items[0].status,'sending');
  f.failReceipt=false;f.expire();
  assert.equal((await resumeIgDeliveries(f.env,f.send))[0].status,'ambiguous');assert.equal(f.sends.length,1);
});
test('lost receipt-write acknowledgement is read back and never resends', async()=>{
  const f=fixture();f.loseAck=true;
  const r=await deliverIgReply(f.env,plan(),f.send);assert.equal(r.status,'complete');assert.equal(f.sends.length,3);
});
test('plan and item-intent persistence must succeed before Instagram is called', async()=>{
  const f=fixture();f.failCreate=true;
  await assert.rejects(deliverIgReply(f.env,plan(),f.send),/create unavailable/);assert.equal(f.sends.length,0);
  f.failCreate=false;f.failIntent=true;
  await assert.rejects(deliverIgReply(f.env,plan(),f.send),/intent unavailable/);assert.equal(f.sends.length,0);
});
test('two simultaneous resumes acquire only one sending lease', async()=>{
  const f=fixture();let release,entered;
  const waiting=new Promise(r=>release=r), ready=new Promise(r=>entered=r);
  const send=async(...args)=>{entered();await waiting;return f.send(...args);};
  const first=deliverIgReply(f.env,plan(),send);await ready;
  const [second]=await resumeIgDeliveries(f.env,send);assert.equal(second.status,'busy');release();
  assert.equal((await first).status,'complete');assert.equal(f.sends.length,3);
});
test('expired sending intent is held as ambiguous, not reclaimed for another send', async()=>{
  const f=fixture();const p=plan();
  f.states.set(igDeliveryKey(p.conversationId,p.incomingAt),JSON.stringify({version:1,...p,items:[{text:'first',status:'sending'}],status:'pending',leaseToken:'old',leaseUntil:0}));
  const [r]=await resumeIgDeliveries(f.env,f.send);assert.equal(r.status,'ambiguous');assert.equal(f.sends.length,0);
});
test('new incoming message supersedes the old unsent suffix', async()=>{
  const f=fixture();f.answers=[{ok:true,messageId:'m1'},{ok:false,delivery:'not_sent'}];
  await deliverIgReply(f.env,plan(),f.send);f.latest='2026-10-23T12:01:00Z';
  const [r]=await resumeIgDeliveries(f.env,f.send);assert.equal(r.status,'superseded');assert.equal(f.sends.length,2);
});
test('completion remains discoverable until handled marker acknowledgement; no resend', async()=>{
  const f=fixture();const p=plan();
  const r=await deliverIgReply(f.env,p,f.send);assert.equal(r.status,'complete');
  assert.equal((await resumeIgDeliveries(f.env,f.send))[0].status,'complete');assert.equal(f.sends.length,3);
  await acknowledgeIgDelivery(f.env,r.key);assert.deepEqual(await resumeIgDeliveries(f.env,f.send),[]);
  await acknowledgeIgDelivery(f.env,r.key);assert.equal(f.sends.length,3);
});
test('incomplete plan cannot be acknowledged as handled', async()=>{
  const f=fixture();f.answers=[{ok:false,delivery:'not_sent'}];
  const r=await deliverIgReply(f.env,plan(),f.send);
  await assert.rejects(acknowledgeIgDelivery(f.env,r.key),/incomplete/);
});

test('browser fallback queues only unsent text and never claims card delivery', async()=>{
  const f=fixture();f.answers=[{ok:true,messageId:'m1'},{ok:false,delivery:'not_sent',error:'Outside allowed window'}];
  const r=await deliverIgReply(f.env,plan(),f.send);const queued=[];
  assert.equal(await queueIgDeliveryTexts(f.env,r.key,async(...args)=>queued.push(args)),true);
  assert.deepEqual(queued, [['creator','second\nthird',r.key]]);
  assert.equal((await resumeIgDeliveries(f.env,f.send))[0].status,'browser');assert.equal(f.sends.length,2);
  await acknowledgeIgDelivery(f.env,r.key);assert.deepEqual(await resumeIgDeliveries(f.env,f.send),[]);
  const g=fixture();g.answers=[{ok:false,delivery:'not_sent',error:'Outside allowed window'}];
  const cards=await deliverIgReply(g.env,{...plan(),cards:['card1']},g.send);
  assert.equal(await queueIgDeliveryTexts(g.env,cards.key,async()=>{throw Error('must not queue images as text');}),false);
});

test('lost browser handoff completion cannot cause API replay or duplicate queued suffix',async()=>{
 const f=fixture();f.answers=[{ok:false,delivery:'not_sent',error:'Outside allowed window'}];
 const r=await deliverIgReply(f.env,plan(),f.send);const queue=new Map();const enqueue=async(handle,text,key)=>queue.set(key,{handle,text});
 f.failBrowserComplete=true;await assert.rejects(queueIgDeliveryTexts(f.env,r.key,enqueue),/handoff unavailable/);
 assert.equal(f.state().browserQueue,true);assert.equal(queue.size,1);
 const [pending]=await resumeIgDeliveries(f.env,f.send);assert.equal(pending.status,'pending');assert.equal(f.sends.length,1);
 f.failBrowserComplete=false;await queueIgDeliveryTexts(f.env,r.key,enqueue);assert.equal(queue.size,1);assert.equal(f.sends.length,1);
});
test('simultaneous callers for the same incoming plan cannot both claim its send',async()=>{
 const f=fixture();let release,entered;const waiting=new Promise(r=>release=r),ready=new Promise(r=>entered=r);
 const send=async(...args)=>{entered();await waiting;return f.send(...args);};
 const first=deliverIgReply(f.env,{...plan(),parts:['single']},send);
 const second=deliverIgReply(f.env,{...plan(),parts:['single']},send);
 await ready;assert.equal((await second).status,'busy');release();assert.equal((await first).status,'complete');assert.equal(f.sends.length,1);
});
