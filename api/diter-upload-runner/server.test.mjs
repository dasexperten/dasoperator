import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import {createDieterServer} from './server.mjs';
test('disconnect never reruns or terminates an accepted child; completion is retained for readback',async(t)=>{
 let resolve,started;const began=new Promise(r=>started=r);let calls=0;
 const server=createDieterServer({infer:async()=>{calls++;started();return await new Promise(r=>resolve=r);}});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const base='http://127.0.0.1:'+server.address().port;
 const req=http.request(base+'/infer',{method:'POST',headers:{'Content-Type':'application/json'}});req.on('error',()=>{});req.end(JSON.stringify({requestId:'one'}));await began;req.destroy();resolve({text:'complete'});
 await new Promise(r=>setTimeout(r,10));assert.equal(await(await fetch(base+'/health')).text(),'ok');assert.deepEqual(await(await fetch(base+'/result/one')).json(),{text:'complete'});
 assert.equal((await fetch(base+'/infer',{method:'POST',body:JSON.stringify({requestId:'one'})})).status,200);assert.equal(calls,1);
});
