// Run with: node tools/tests/gmail-counts.mjs (requires installed web dependencies).
import assert from 'node:assert/strict';
import { build } from '../../web/node_modules/esbuild/lib/main.js';
const built = await build({ entryPoints:['api/src/lib/gmail-counts.ts'], bundle:true, platform:'node',format:'esm',write:false });
const { gmailCount } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
let calls=[];
const serve = (responses) => { calls=[];globalThis.fetch=async url=>{calls.push(url);const response=responses.shift();assert.ok(response,'Unexpected Google request');return new Response(JSON.stringify(response),{status:200});}; };
serve([{messagesTotal:12,messagesUnread:3}]);assert.deepEqual(await gmailCount('test',{key:'INBOX',label:'INBOX',unread:true}),{value:3,more:false});
serve([{messagesTotal:0,messagesUnread:0}]);assert.deepEqual(await gmailCount('test',{key:'DRAFT',label:'DRAFT'}),{value:0,more:false});
serve([{messages:[{id:'a'},{id:'b'}],nextPageToken:'page2',resultSizeEstimate:900},{messages:[{id:'b'},{id:'c'}],resultSizeEstimate:900}]);assert.deepEqual(await gmailCount('test',{key:'archive',q:'-in:inbox'}),{value:3,more:false});assert.ok(calls[1].includes('pageToken=page2'));
serve(Array.from({length:4},(_,i)=>({messages:[{id:String(i)}],nextPageToken:'next'})));assert.deepEqual(await gmailCount('test',{key:'all'}),{value:4,more:true});assert.equal(calls.length,4);
serve([{}]);await assert.rejects(gmailCount('test',{key:'INBOX',label:'INBOX'}));
globalThis.fetch=async()=>new Response('{}',{status:403});await assert.rejects(gmailCount('test',{key:'all'}));
console.log('PASS: unread and total labels, zero, pagination, deduplication, lower-bound cap, missing count and Google errors.');
