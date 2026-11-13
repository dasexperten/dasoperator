import test from 'node:test';
import assert from 'node:assert/strict';
import {boardReceipt,saveBoardReceipt} from './board.mjs';
test('Yerevan day boundary and complete receipt',()=>{
 const r=boardReceipt('2026-11-13T20:30:00Z',{state:'sent',complete:true,message_id:42});
 assert.equal(r.day,'2026-11-14');assert.equal(r.status,'done');assert.equal(r.percent,100);
 assert.match(r.artifact,/date=2026-11-14$/);
});
test('delivery with source gaps is blocked rather than completed',()=>{
 const r=boardReceipt('2026-11-13T05:00:00Z',{state:'sent',complete:false,message_id:42});
 assert.equal(r.status,'blocked');assert.equal(r.percent,75);assert.match(r.note,/Telegram 42/);
});
test('a missing delivery is never a completed board run',()=>{
 const r=boardReceipt('2026-11-13T05:00:00Z',null,'source error');
 assert.equal(r.status,'blocked');assert.equal(r.percent,0);
});
test('board write failure is propagated',async()=>{
 const db={prepare(){return{bind(){return{run:async()=>({success:false})}}}}};
 await assert.rejects(saveBoardReceipt(db,'2026-11-13T05:00:00Z',{state:'sent',complete:true,message_id:42}),/not persisted/);
});
