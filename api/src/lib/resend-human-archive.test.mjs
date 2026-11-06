import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const require=createRequire(import.meta.url);
const dir=mkdtempSync(join(tmpdir(),'sent-archive-'));
const outfile=join(dir,'sent.mjs');
await require('esbuild').build({entryPoints:[fileURLToPath(new URL('./resend-human.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',outfile,plugins:[{name:'archive-failure',setup(build){build.onResolve({filter:/^\.\/inbox-archive$/},()=>({path:'archive',namespace:'fixture'}));build.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export async function archiveEmail(env){if(env.archiveFailure)throw Error(env.archiveFailure);return "stored";}'}));}}]});
const {sendHumanResend}=await import(pathToFileURL(outfile));
rmSync(dir,{recursive:true});
const params={from:'logistics@dasexperten.com',to:['recipient@example.com'],subject:'Archive existing delivery',text:'Existing delivered body for the requested archive.',messageId:'already-delivered',archive_only:true};
test('read failure preserves delivery and returns actual archive cause without sending again',async()=>{
 const fetchBefore=globalThis.fetch;let requests=0;globalThis.fetch=async()=>{requests++;throw Error('must not send');};
 try{const r=await sendHumanResend({ARCHIVE:{get:async()=>{throw Error('get: internal error (10001)');}}},params);assert.equal(r.success,true);assert.equal(r.archived,false);assert.equal(r.messageId,'already-delivered');assert.equal(r.archiveError,'get: internal error (10001)');assert.equal(requests,0);}finally{globalThis.fetch=fetchBefore;}
});
test('write failure reports actual cause; successful backfill has no error',async()=>{
 const env={ARCHIVE:{get:async()=>null},archiveFailure:'put: archive unavailable'};
 const failed=await sendHumanResend(env,params);assert.equal(failed.archived,false);assert.equal(failed.archiveError,'put: archive unavailable');
 const ok=await sendHumanResend({...env,archiveFailure:null},params);assert.equal(ok.archived,true);assert.equal(ok.archiveError,undefined);
});
