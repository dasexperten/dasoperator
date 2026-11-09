import test from 'node:test';import assert from 'node:assert/strict';
import {createRequire} from 'node:module';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';
const require=createRequire(import.meta.url),out=join(mkdtempSync(join(tmpdir(),'workspace-receipt-')),'workspace.mjs');
await require('esbuild').build({entryPoints:[fileURLToPath(new URL('./google-workspace.ts',import.meta.url))],outfile:out,bundle:true,format:'esm',platform:'node'});
const {workspaceReceiptComplete}=await import(pathToFileURL(out));
const key='Inbox/sales@dasexperten.com/received/message.json',file=key.slice(0,-5)+'/att/0-image.png';
function env(size,missingRecord=false){return {ARCHIVE:{get:async()=>missingRecord?null:{json:async()=>({attachments:[{key:file,size:10}]})},head:async()=>size===null?null:{size}}};}
test('receipt alone cannot hide a missing archived message',async()=>assert.equal(await workspaceReceiptComplete(env(10,true),{keys:[key],attachments:1}),false));
test('receipt alone cannot hide a missing or truncated attachment',async()=>{for(const size of [null,0,9])assert.equal(await workspaceReceiptComplete(env(size),{keys:[key],attachments:1}),false);});
test('complete archived bytes permit idempotent source replay',async()=>assert.equal(await workspaceReceiptComplete(env(10),{keys:[key],attachments:1}),true));
test('receipt with lost attachment metadata must be repaired',async()=>assert.equal(await workspaceReceiptComplete(env(10),{keys:[key],attachments:2}),false));
