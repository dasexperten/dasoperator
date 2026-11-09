import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
const out=await build({entryPoints:[fileURLToPath(new URL('./diana-video-reminder-schedule.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',write:false,plugins:[{name:'fake-queue',setup(b){b.onResolve({filter:/^\.\/ugc-payout-store$/},()=>({path:'queue',namespace:'fake'}));b.onLoad({filter:/.*/,namespace:'fake'},()=>({contents:'export async function overdueVideoReminders(){globalThis.__videoCalls++;if(globalThis.__videoFail)throw new Error("queue failed");return 4}'}))}}]});
const {startDailyVideoReminders}=await import('data:text/javascript;base64,'+Buffer.from(out.outputFiles[0].text).toString('base64'));
const at=(day,h,m=0)=>Date.UTC(2026,10,day,h-4,m);
test('opens once after 07:00 Yerevan and remains closed before and after that hour',async()=>{
  const markers=new Map();globalThis.__videoCalls=0;
  const env={DB:{prepare(){return {bind(...args){return {async first(){return markers.has(args[0])?{value:markers.get(args[0])}:null},async run(){markers.set(args[0],args[1])}}}}}}};
  assert.equal((await startDailyVideoReminders(env,at(8,6,59))).due,false);
  assert.equal((await startDailyVideoReminders(env,at(8,7))).queued,4);
  assert.equal(markers.get('diana_video_reminder_batch_day'),'2026-11-08');
  assert.equal((await startDailyVideoReminders(env,at(8,7,3))).due,false);
  assert.equal((await startDailyVideoReminders(env,at(9,8))).due,false);
  assert.equal((await startDailyVideoReminders(env,at(9,7))).queued,4);
  assert.equal(globalThis.__videoCalls,2);
});

test('a partial queue failure keeps the batch open and retries on the next tick',async()=>{
  const markers=new Map();globalThis.__videoCalls=0;globalThis.__videoFail=true;
  const env={DB:{prepare(){return {bind(...args){return {async first(){return markers.has(args[0])?{value:markers.get(args[0])}:null},async run(){markers.set(args[0],args[1])}}}}}}};
  const failed=await startDailyVideoReminders(env,at(9,7));
  assert.equal(failed.opened,true);assert.equal(markers.get('diana_video_reminder_batch_day'),'2026-11-09');
  assert.equal(markers.has('diana_video_reminder_batch_completed_day'),false);assert.equal(failed.error,'queue failed');
  globalThis.__videoFail=false;
  const retry=await startDailyVideoReminders(env,at(9,7,3));
  assert.equal(retry.queued,4);assert.equal(markers.get('diana_video_reminder_batch_completed_day'),'2026-11-09');assert.equal(globalThis.__videoCalls,2);
});
