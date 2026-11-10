import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {deliverDirectReply} from './diana-direct-deliver.mjs';
function fixture(t,{failProof=false,changed=false}={}){
 const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());sql.exec('CREATE TABLE crm_sync_state(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER)');
 const db={prepare(q){let values=[];const p={bind(...v){values=v;return p;},async first(){return sql.prepare(q).get(...values)??null;},async run(){return {meta:{changes:Number(sql.prepare(q).run(...values).changes)}};}};return p;}};
 let sends=0;
 const fetchImpl=async(url,init={})=>{if(url.includes('fields=access_token'))return Response.json({access_token:'fixture'});if(url.includes('limit=1'))return Response.json({data:[{id:changed?'new':'m1',from:{id:'creator'},created_time:'2026-11-11T09:00:00Z'}]});if(init.method==='POST'){sends++;return Response.json({message_id:'out1'});}if(failProof)return new Response('',{status:503});return Response.json({id:'out1',from:{id:'17841466350261166'},message:'PRIVATE TEST REPLY'});};
 const input={db,conversationId:'chat',messageId:'m1',recipientId:'creator',text:'PRIVATE TEST REPLY',token:'fixture',fetchImpl};
 return {sql,input,sends:()=>sends};
}
test('verifies one original receipt without storing any message text',async t=>{const f=fixture(t);assert.equal((await deliverDirectReply(f.input)).status,'verified');assert.equal((await deliverDirectReply(f.input)).status,'already_claimed');assert.equal(f.sends(),1);assert.doesNotMatch(JSON.stringify(f.sql.prepare('SELECT * FROM crm_sync_state').all()),/PRIVATE TEST REPLY/);});
test('ambiguous delivery never retries',async t=>{const f=fixture(t,{failProof:true});assert.equal((await deliverDirectReply(f.input)).status,'unknown');assert.equal((await deliverDirectReply(f.input)).status,'already_claimed');assert.equal(f.sends(),1);});
test('a changed latest message prevents a send',async t=>{const f=fixture(t,{changed:true});assert.equal((await deliverDirectReply(f.input)).status,'superseded');assert.equal(f.sends(),0);});
test('a new incoming message after the claim prevents the outgoing reply',async t=>{
 const f=fixture(t);let reads=0;const original=f.input.fetchImpl;
 f.input.fetchImpl=async(url,init)=>{if(url.includes('limit=1')&&++reads===2)return Response.json({data:[{id:'new',from:{id:'creator'}}]});return original(url,init);};
 assert.equal((await deliverDirectReply(f.input)).status,'superseded');assert.equal(f.sends(),0);
});
test('an old delivery plan for this message is held for reconciliation',async t=>{const f=fixture(t);f.sql.prepare('INSERT INTO crm_sync_state VALUES(?,?,?)').run('ig_reply_delivery:chat:old',JSON.stringify({conversationId:'chat',incomingAt:'2026-11-11T09:00:00Z',status:'ambiguous',items:[{text:'PRIVATE OLD'}]}),1);assert.equal((await deliverDirectReply(f.input)).status,'legacy_delivery_review');assert.equal(f.sends(),0);});
