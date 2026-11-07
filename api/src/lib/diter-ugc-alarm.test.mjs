import test from 'node:test';
import assert from 'node:assert/strict';
import { inMoscowWindow, alarmState, freshSignal } from './diter-ugc-alarm.mjs';

test('all seven Moscow days, exact opening/closing minutes and Sunday evening', () => {
  const windows = {0:[[1170,1290]],1:[[735,810]],2:[[480,630],[735,810]],
    3:[[480,630],[735,810],[1170,1290]],4:[[480,630],[735,810]],5:[[735,810]],6:[]};
  for(let day=0;day<7;day++) for(let minute=0;minute<1440;minute++) {
    // 2026-11-08 is Sunday; Moscow midnight is 21:00 UTC on the previous day.
    const now=new Date(Date.UTC(2026,10,7+day,21,minute));
    assert.equal(inMoscowWindow(now), windows[day].some(([a,b])=>minute>=a&&minute<b),`day=${day} minute=${minute}`);
  }
});
test('oldest eligible row only, working blocks globally, cooldown survives release and signal expires',()=>{
  const now=new Date('2026-11-10T09:15:00.000Z');
  const row={content_id:'one',status:'queued',attempts:0,dispatch_attempts:0};
  assert.equal(alarmState([row],now).content_id,'one');
  assert.equal(alarmState([{...row,attempts:3}],now).state,'empty_or_attempt_limit');
  assert.equal(alarmState([row,{...row,status:'working'}],now).state,'working');
  assert.equal(alarmState([{...row,started_at:new Date(now-899999).toISOString()}],now).state,'cooldown');
  assert.equal(alarmState([{...row,started_at:new Date(now-900000).toISOString()}],now).state,'ready');
  const signal=JSON.stringify(alarmState([row],now));
  assert.ok(freshSignal(signal,now));
  assert.equal(freshSignal(signal,new Date(+now+180000)),null);
  assert.equal(freshSignal(signal,new Date(+now-1)),null);
  assert.equal(freshSignal('bad-json',now),null);
});
