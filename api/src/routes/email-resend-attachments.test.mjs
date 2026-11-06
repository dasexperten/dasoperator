import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const require=createRequire(import.meta.url);
const dir=mkdtempSync(join(tmpdir(),'service-attachments-'));
const outfile=join(dir,'route.mjs');
await require('esbuild').build({entryPoints:[fileURLToPath(new URL('./email-resend.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',outfile,plugins:[{name:'capture-send',setup(build){build.onResolve({filter:/resend-human$/},()=>({path:'send',namespace:'fixture'}));build.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const extractEmailAddr=s=>s; export async function sendHumanResend(env,p){env.calls.push(p);return {success:true,messageId:"test-id",archived:true}}'}));}}]});
const {default:route}=await import(pathToFileURL(outfile));
rmSync(dir,{recursive:true});
const file={filename:'price-list.pdf',content:Buffer.from('%PDF-1.7\nverified fixture').toString('base64'),mimeType:'application/pdf'};
const common={from:'lauda@dasexperten.com',to:['buyer@example.com'],subject:'Requested price list',text:'Attached price list.'};
for(const endpoint of ['resend-send','archive-sent']) test(`${endpoint} preserves base64 PDF bytes through request validation`,async()=>{
 const env={EMAILER_SERVICE_SECRET:'test',calls:[]};
 const res=await route.request(`http://localhost/${endpoint}`,{method:'POST',headers:{'Content-Type':'application/json','X-Emailer-Service-Secret':'test'},body:JSON.stringify({...common,messageId:'existing-id',attachments:[file]})},env);
 assert.equal(res.status,200);assert.equal(env.calls.length,1);
 assert.deepEqual(env.calls[0].attachments,[{...file,encoding:'base64'}]);
 assert.equal(Buffer.from(env.calls[0].attachments[0].content,'base64').toString(),'%PDF-1.7\nverified fixture');
 if(endpoint==='archive-sent') assert.equal(env.calls[0].archive_only,true);
});
test('invalid attachment input fails before any send',async()=>{
 const env={EMAILER_SERVICE_SECRET:'test',calls:[]};
 const res=await route.request('http://localhost/resend-send',{method:'POST',headers:{'Content-Type':'application/json','X-Emailer-Service-Secret':'test'},body:JSON.stringify({...common,attachments:[{filename:'price-list.pdf'}]})},env);
 assert.equal(res.status,422);assert.equal(env.calls.length,0);
});
