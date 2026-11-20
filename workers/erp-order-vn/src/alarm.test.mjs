import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {dayKey,expireAbandonedClaims,signal,validEvidence} from './alarm.mjs';
test('Yerevan date crosses at 20 UTC and stays stable across daily replay',()=>{
  assert.equal(dayKey(new Date('2026-11-08T19:59:59Z')),'erp-order-vn:2026-11-08');
  assert.equal(dayKey(new Date('2026-11-08T20:00:00Z')),'erp-order-vn:2026-11-09');
  assert.equal(dayKey(new Date('2026-11-09T02:00:00Z')),dayKey(new Date('2026-11-09T02:01:00Z')));
});
test('alarm wakes Tet with finance seam and never claims fiscal completion',()=>{
  const row=signal(new Date('2026-11-09T02:00:00Z'));
  assert.equal(row.state,'pending'); assert.equal(row.target,'tet'); assert.equal(row.finance,'justina-timber');
});
test('exit code or bare prose cannot complete a job',()=>{
  assert.ok(!validEvidence({exit_code:0})); assert.ok(!validEvidence({note:'done',evidence:[]}));
  assert.ok(validEvidence({note:'source reconciled',evidence:['operation:real-source-id']}));
});

test('an abandoned claim stops blocking the queue without becoming eligible for replay',async t=>{
  const sqlite=new DatabaseSync(':memory:');
  t.after(()=>sqlite.close());
  sqlite.exec('CREATE TABLE crm_sync_state (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)');
  const put=sqlite.prepare('INSERT INTO crm_sync_state VALUES (?, ?, 0)');
  for (const [key,state,started_at] of [
    ['erp-order-vn:2026-11-18','working','2026-11-18T15:00:00.000Z'],
    ['erp-order-vn:2026-11-19','working','2026-11-20T10:00:00.000Z'],
    ['erp-order-vn:2026-11-20','pending',null],
    ['another-job:2026-11-18','working','2026-11-18T15:00:00.000Z'],
  ]) put.run(key,JSON.stringify({state,started_at}));
  const db={prepare:sql=>({bind:(...args)=>({run:async()=>({meta:sqlite.prepare(sql).run(...args)})})})};
  const now=new Date('2026-11-20T15:00:00.000Z');
  assert.equal(await expireAbandonedClaims(db,now),1);
  assert.equal(await expireAbandonedClaims(db,now),0);
  const saved=sqlite.prepare('SELECT key,value FROM crm_sync_state').all().map(row=>[row.key,JSON.parse(row.value)]);
  assert.deepEqual(saved.map(([key,row])=>[key,row.state]),[
    ['erp-order-vn:2026-11-18','blocked'],
    ['erp-order-vn:2026-11-19','working'],
    ['erp-order-vn:2026-11-20','pending'],
    ['another-job:2026-11-18','working'],
  ]);
  assert.ok(validEvidence(saved[0][1]));
});
