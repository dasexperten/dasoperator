import assert from 'node:assert/strict';
import { build } from '../../web/node_modules/esbuild/lib/main.js';
const built = await build({entryPoints:['api/src/lib/gmail-map.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {gmailMap} = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const tick = () => new Promise(resolve => setImmediate(resolve));
let active=0, peak=0;
const started=[], release=new Map();
const pending=gmailMap(Array.from({length:12},(_,i)=>i),async i=>{
  started.push(i);peak=Math.max(peak,++active);
  await new Promise(resolve=>release.set(i,resolve));
  active--;return i*2;
});
assert.deepEqual(started,[0,1,2,3,4]);
release.get(3)();await tick();
assert.deepEqual(started,[0,1,2,3,4,5],'A free slot must start the next message before slow earlier messages finish');
for(let i=0;i<12;i++) {release.get(i)?.();await tick();}
assert.deepEqual(await pending,Array.from({length:12},(_,i)=>i*2),'Completion order must not change inbox order');
assert.equal(peak,5);
assert.deepEqual(await gmailMap([],async()=>assert.fail('Empty list must not issue requests')),[]);
let calls=0;
await assert.rejects(gmailMap([1,2,3,4,5,6,7],async()=>{calls++;throw new Error('Google failed');}),/Google failed/);
await tick();assert.equal(calls,5,'Do not start more requests after a failure');
console.log('PASS: immediate slot refill, five-request limit, stable ordering, empty inbox, failure propagation.');
