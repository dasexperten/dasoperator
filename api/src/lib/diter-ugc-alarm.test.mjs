import {isTikTokPeakTime,YEREVAN_SCHEDULE} from './tiktok-peak-hours.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { inMoscowWindow, isTriggerMinute, alarmState, freshSignal, ALARM, alarmWireName } from './diter-ugc-alarm.mjs';

test('shared round retains only peak-hour starts after 09:00 Yerevan', () => {
  const weekday=[900,990,1080], weekend=[780,870,960,1050,1140];
  const expected={0:weekend,1:weekday,2:weekday,3:weekday,4:weekday,5:weekday,6:weekend};
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
  const now=new Date('2026-11-10T12:00:00.000Z');
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


test('TikTok provider gate uses Yerevan boundaries, includes weekends, and rejects every hour before 09:00',()=>{
 for(let day=0;day<7;day++)for(let minute=0;minute<1440;minute++){
  const local=new Date(Date.UTC(2026,10,23+day,0,minute)),instant=+local-4*3600_000;
  const weekend=day>=5,expected=weekend?minute>=14*60&&minute<21*60:minute>=15*60&&minute<20*60;
  assert.equal(isTikTokPeakTime(instant),expected,local.toISOString());
 }
 assert.equal(isTikTokPeakTime(NaN),false);
 assert.deepEqual(YEREVAN_SCHEDULE.weekdays,['16:00','17:30','19:00']);
 assert.deepEqual(YEREVAN_SCHEDULE.weekends,['14:00','15:30','17:00','18:30','20:00']);
});
