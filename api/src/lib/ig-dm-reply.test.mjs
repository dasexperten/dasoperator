import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const result = await build({entryPoints:[new URL('./ig-dm-reply.ts',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1')],bundle:true,platform:'node',format:'esm',write:false});
const {igDmReply}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
test('the retired ERP writer cannot read, interpret or send a message',async()=>{
 const env=new Proxy({}, {get(){throw new Error('ERP must not inspect content or invoke providers')}});
 assert.deepEqual(await igDmReply(env),{replied:0,escalated:0,errors:0,alarm_only:true});
});
