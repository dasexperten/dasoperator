import test from 'node:test';
import assert from 'node:assert/strict';
import { inMoscowWindow, isTriggerMinute, alarmState, freshSignal, ALARM, alarmWireName } from './diter-ugc-alarm.mjs';

test('approved fixed Moscow times cover the whole week; weekends match, evenings are daily', () => {
  const evenings=[1170,1200,1230,1260], midday=[735,765,795], mornings=[480,510,540,570,600], weekend=[630,660,690,720,750];
  const expected={0:[...weekend,...evenings],1:[...midday,...evenings],2:[...mornings,...midday,...evenings],
    3:[...mornings,...midday,...evenings],4:[...mornings,...midday,...evenings],5:[...midday,...evenings],6:[...weekend,...evenings]};
  for(let day=0;day<7;day++) for(let minute=0;minute<1440;minute++) {
    const now=new Date(Date.UTC(2026,10,7+day,21,minute));
    assert.equal(isTriggerMinute(now),expected[day].includes(minute),`trigger day=${day} minute=${minute}`);
    assert.equal(inMoscowWindow(now),expected[day].some(slot=>minute>=slot&&minute<slot+3),`preflight day=${day} minute=${minute}`);
  }
  assert.equal(ALARM,'erp-ugc-diter');
  assert.equal(alarmWireName(ALARM),ALARM);
  assert.equal(alarmWireName(undefined),'diter-ugc-alarm','installed legacy clients remain connected');
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
