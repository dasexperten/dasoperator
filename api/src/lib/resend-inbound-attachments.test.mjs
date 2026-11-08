import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const require=createRequire(import.meta.url),dir=mkdtempSync(join(tmpdir(),'receiving-files-'));
const {transformSync}=require('esbuild');
writeFileSync(join(dir,'helper.mjs'),transformSync(readFileSync(new URL('./resend-inbound-attachments.ts',import.meta.url),'utf8'),{loader:'ts',format:'esm'}).code);
const {receivedAttachments}=await import(pathToFileURL(join(dir,'helper.mjs')));
const meta={id:'file1',filename:'image.png',size:4,content_type:'image/png',content_disposition:'inline',content_id:'image1',download_url:'https://inbound-cdn.resend.com/file1'};
test('receiving lists and downloads actual image bytes without forwarding API credentials to CDN',async()=>{
 const old=globalThis.fetch;globalThis.fetch=async(url,init)=>{
  if(String(url).startsWith('https://api.resend.com/')){assert.equal(init.headers.Authorization,'Bearer fixture');return Response.json({data:[meta],has_more:false});}
  assert.equal(init.headers,undefined);assert.equal(init.redirect,'error');return new Response(new Uint8Array([1,2,3,4]));
 };
 try{const rows=await receivedAttachments('fixture','message');assert.equal(rows[0].contentId,'image1');assert.equal(rows[0].disposition,'inline');assert.deepEqual([...new Uint8Array(rows[0].content)],[1,2,3,4]);}finally{globalThis.fetch=old;}
});
test('truncated file fails instead of acknowledging a missing attachment',async()=>{
 const old=globalThis.fetch;globalThis.fetch=async url=>String(url).startsWith('https://api.resend.com/')?Response.json({data:[meta],has_more:false}):new Response(new Uint8Array([1,2]));
 try{await assert.rejects(receivedAttachments('fixture','message'),/size_mismatch/);}finally{globalThis.fetch=old;}
});
test('untrusted file URL is never fetched',async()=>{
 const old=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({data:[{...meta,download_url:'https://example.org/private'}],has_more:false});};
 try{await assert.rejects(receivedAttachments('fixture','message'),/url_invalid/);assert.equal(calls,1);}finally{globalThis.fetch=old;}
});
test('empty or repeated pagination fails explicitly',async()=>{
 const old=globalThis.fetch;globalThis.fetch=async()=>Response.json({data:[],has_more:true});
 try{await assert.rejects(receivedAttachments('fixture','message'),/pagination_invalid/);}finally{globalThis.fetch=old;}
});
