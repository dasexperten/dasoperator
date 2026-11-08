import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
const out=await build({entryPoints:[fileURLToPath(new URL('./diana-video-reminder-schedule.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',write:false,plugins:[{name:'fake-queue',setup(b){b.onResolve({filter:/^\.\/ugc-payout-store$/},()=>({path:'queue',namespace:'fake'}));b.onLoad({filter:/.*/,namespace:'fake'},()=>({contents:'export async function overdueVideoReminders(){globalThis.__videoCalls++;return 4}'}))}}]});
const {startDailyVideoReminders}=await import('data:text/javascript;base64,'+Buffer.from(out.outputFiles[0].text).toString('base64'));
const at=(day,h,m=0)=>Date.UTC(2026,10,day,h-4,m);
test('opens once after 07:00 Yerevan and remains closed before and after that hour',async()=>{
  let marker;globalThis.__videoCalls=0;
  const env={DB:{prepare(){return {bind(...args){return {async first(){return marker?{value:marker}:null},async run(){marker=args[1]}}}}}}};
  assert.equal((await startDailyVideoReminders(env,at(8,6,59))).due,false);
  assert.equal((await startDailyVideoReminders(env,at(8,7))).queued,4);
  assert.equal(marker,'2026-11-08');
  assert.equal((await startDailyVideoReminders(env,at(8,7,3))).due,false);
  assert.equal((await startDailyVideoReminders(env,at(9,8))).due,false);
  assert.equal((await startDailyVideoReminders(env,at(9,7))).queued,4);
  assert.equal(globalThis.__videoCalls,2);
});
