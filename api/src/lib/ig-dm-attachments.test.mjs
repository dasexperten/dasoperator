import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
let build;const require=createRequire(import.meta.url);
try{({build}=require('esbuild'));}catch{({build}=createRequire(new URL('../../../workers/package.json',import.meta.url))('esbuild'));}
const dir=mkdtempSync(join(tmpdir(),'ugc-images-')),outfile=join(dir,'attachments.mjs');
await build({entryPoints:[fileURLToPath(new URL('./ig-dm-attachments.ts',import.meta.url))],outfile,bundle:true,platform:'node',format:'esm',plugins:[{name:'read-only',setup(b){b.onResolve({filter:/^\.\/ig-dm-watch$/},()=>({path:'watch',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export const refreshIgAttachments=(...args)=>globalThis.__ugcImageRefresh(...args);'}));}}]});
const {incomingScreenshots,imageUrls}=await import(pathToFileURL(outfile));rmSync(dir,{recursive:true});
const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY4sAAAAASUVORK5CYII=';
const at='2026-10-17T00:00:00.000Z',url='https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=fixture';
const msg=(extra={})=>({id:'message',direction:'in',created_at:at,attachments_json:JSON.stringify([{image_data:{url}}]),...extra});
const png=()=>new Response(Buffer.from(PNG,'base64'),{headers:{'content-type':'image/png'}});
async function fakeFetch(fn,run){const orig=globalThis.fetch;globalThis.fetch=fn;try{return await run();}finally{globalThis.fetch=orig;}}
test('real image bytes and chronological labels reach vision; outgoing cards do not',async()=>{
 await fakeFetch(async()=>png(),async()=>{const images=await incomingScreenshots({},[msg({direction:'out'}),msg()],at);assert.equal(images.length,1);assert.equal(images[0].data,PNG);assert.equal(images[0].mediaType,'image/png');assert.match(images[0].label,/2026-10-17/);});
});
test('expired CDN link is refreshed through the existing Instagram message',async()=>{
 let refreshed=0;globalThis.__ugcImageRefresh=async(_e,id)=>{assert.equal(id,'message');refreshed++;return JSON.stringify([{image_data:{url:url+'&fresh=1'}}]);};
 await fakeFetch(async u=>String(u).includes('fresh=1')?png():new Response('',{status:403}),async()=>{const images=await incomingScreenshots({},[msg()],at);assert.equal(images[0].data,PNG);assert.equal(refreshed,1);});
});
test('truncated attachment JSON is refreshed rather than silently ignored',async()=>{
 globalThis.__ugcImageRefresh=async()=>JSON.stringify([{image_data:{url}}]);await fakeFetch(async()=>png(),async()=>{assert.equal((await incomingScreenshots({},[msg({attachments_json:'[{"image_data":'})],at)).length,1);});
});
test('unreadable image fails; unsafe hosts are never fetched',async()=>{
 globalThis.__ugcImageRefresh=async()=>null;
 await fakeFetch(async()=>new Response('',{status:403}),async()=>{await assert.rejects(incomingScreenshots({},[msg()],at));});
 let fetched=false;await fakeFetch(async()=>{fetched=true;return png();},async()=>{await assert.rejects(incomingScreenshots({},[msg({attachments_json:JSON.stringify([{image_data:{url:'https://example.org/private'}}])})],at));assert.equal(fetched,false);});
});
test('missing image URL is not accepted as a text-only message',()=>{assert.throws(()=>imageUrls('[{"image_data":{}}]'));});
test('latest six incoming images stay ordered, older than seven days are omitted',async()=>{
 const history=[msg({created_at:'2026-10-01T00:00:00Z'}),...Array.from({length:8},(_,i)=>msg({id:String(i),created_at:`2026-10-16T12:0${i}:00Z`}))];
 await fakeFetch(async()=>png(),async()=>{const images=await incomingScreenshots({},history,at);assert.equal(images.length,6);assert.match(images[0].label,/12:02/);assert.match(images.at(-1).label,/12:07/);});
});
