import test from 'node:test';
import assert from 'node:assert/strict';
import { reelClickController } from './ugc-reel-click.mjs';
function setup(queueResult=true){
  let opened=0,queued=0,id=0;const timers=new Map();
  const ctrl=reelClickController({open(){opened++;},async queue(){queued++;return queueResult;},schedule(fn,ms){assert.equal(ms,600);timers.set(++id,fn);return id;},cancel(id){timers.delete(id);}});
  return {ctrl,timers,tick(){for(const fn of timers.values())fn();timers.clear();},get opened(){return opened;},get queued(){return queued;}};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('single click opens exactly one source after its double-click window',()=>{const s=setup();s.ctrl.click(1);assert.equal(s.opened,0);s.tick();assert.equal(s.opened,1);assert.equal(s.queued,0);});
test('each completed double-click can change selection on the same icon', async () => {
  for (const counts of [[1, 2, 1, 2], [1, 2, 3, 4]]) {
    const s = setup();
    for (const detail of counts) {
      s.ctrl.click(detail);
      await flush();
    }
    s.tick();
    assert.equal(s.queued, 2);
    assert.equal(s.opened, 0);
  }
});

test('one selection request at a time', async () => {
  const s = setup();
  s.ctrl.click(2);
  s.ctrl.click(2);
  await flush();
  assert.equal(s.queued, 1);
});
test('failed queue is retryable and disposal cancels pending source navigation',async()=>{const s=setup(false);s.ctrl.click(1);s.ctrl.click(2);await flush();s.ctrl.click(2);await flush();assert.equal(s.queued,2);s.ctrl.click(1);s.ctrl.dispose();s.tick();assert.equal(s.opened,0);assert.equal(s.timers.size,0);});
