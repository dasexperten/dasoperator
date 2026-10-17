import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire}from'node:module';
import{mkdtempSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';import{fileURLToPath,pathToFileURL}from'node:url';
let build;const require=createRequire(import.meta.url);try{({build}=require('esbuild'));}catch{({build}=createRequire(new URL('../../../workers/package.json',import.meta.url))('esbuild'));}
const dir=mkdtempSync(join(tmpdir(),'ig-refresh-')),outfile=join(dir,'watch.mjs');await build({entryPoints:[fileURLToPath(new URL('./ig-dm-watch.ts',import.meta.url))],outfile,bundle:true,platform:'node',format:'esm'});const{refreshIgAttachments}=await import(pathToFileURL(outfile));rmSync(dir,{recursive:true});
async function run(messages,assertResult){
 const original=globalThis.fetch,urls=[],updates=[];
 globalThis.fetch=async url=>{urls.push(url);return Response.json(url.includes('fields=access_token')?{access_token:'fake-page'}:{messages:{data:messages}});};
 const env={META_IG_MESSAGING_TOKEN:'fake',DB:{prepare(sql){let p;const st={bind(...v){p=v;return st;},async first(){return{conversation_id:'conversation',created_at:'2026-10-17T01:00:00Z',from_id:'blogger'};},async run(){updates.push({sql,p});return{success:true};}};return st;}}};
 try{const result=await refreshIgAttachments(env,'old-id');await assertResult(result,urls,updates);}finally{globalThis.fetch=original;}
}
test('refresh reads the conversation when Meta no longer accepts the old message id',async()=>{
 const attachment={image_data:{url:'https://lookaside.fbsbx.com/fresh'}};
 await run([{id:'new-id',created_time:'2026-10-17T01:00:00+0000',from:{id:'blogger'},attachments:{data:[attachment]}}],async(result,urls,updates)=>{assert.deepEqual(JSON.parse(result),[attachment]);assert.ok(urls.some(u=>u.includes('/conversation?fields=messages')));assert.equal(urls.some(u=>u.includes('/old-id?')),false);assert.equal(updates.length,1);});
});
test('ambiguous or absent messages do not attach another image to the blogger',async()=>{
 const m={id:'new',created_time:'2026-10-17T01:00:00Z',from:{id:'blogger'},attachments:{data:[]}};
 await run([m,{...m,id:'another'}],async(result,_urls,updates)=>{assert.equal(result,null);assert.equal(updates.length,0);});
 await run([{...m,from:{id:'another-person'}}],async(result,_urls,updates)=>{assert.equal(result,null);assert.equal(updates.length,0);});
});
