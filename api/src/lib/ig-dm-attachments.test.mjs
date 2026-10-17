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
 await fakeFetch(async()=>png(),async()=>{const {images}=await incomingScreenshots({},[msg({direction:'out'}),msg()],at);assert.equal(images.length,1);assert.equal(images[0].data,PNG);assert.equal(images[0].mediaType,'image/png');assert.match(images[0].label,/2026-10-17/);});
});
test('expired CDN link is refreshed through the existing Instagram message',async()=>{
 let refreshed=0;globalThis.__ugcImageRefresh=async(_e,id)=>{assert.equal(id,'message');refreshed++;return JSON.stringify([{image_data:{url:url+'&fresh=1'}}]);};
 await fakeFetch(async u=>String(u).includes('fresh=1')?png():new Response('',{status:403}),async()=>{const {images}=await incomingScreenshots({},[msg()],at);assert.equal(images[0].data,PNG);assert.equal(refreshed,1);});
});
test('truncated attachment JSON is refreshed rather than silently ignored',async()=>{
 globalThis.__ugcImageRefresh=async()=>JSON.stringify([{image_data:{url}}]);await fakeFetch(async()=>png(),async()=>{assert.equal((await incomingScreenshots({},[msg({attachments_json:'[{"image_data":'})],at)).images.length,1);});
});
test('unreadable image fails; unsafe hosts are never fetched',async()=>{
 globalThis.__ugcImageRefresh=async()=>null;
 await fakeFetch(async()=>new Response('',{status:403}),async()=>{assert.equal((await incomingScreenshots({},[msg()],at)).unreadable,1);});
 let fetched=false;await fakeFetch(async()=>{fetched=true;return png();},async()=>{assert.equal((await incomingScreenshots({},[msg({attachments_json:JSON.stringify([{image_data:{url:'https://example.org/private'}}])})],at)).unreadable,1);assert.equal(fetched,false);});
});
test('missing image URL is not accepted as a text-only message',()=>{assert.throws(()=>imageUrls('[{"image_data":{}}]'));});

test('a real PNG mislabeled JPEG by Meta reaches both readers as PNG',async()=>{
 await fakeFetch(async()=>new Response(Buffer.from(PNG,'base64'),{headers:{'content-type':'image/jpeg'}}),async()=>{const result=await incomingScreenshots({},[msg()],at);assert.equal(result.images.length,1);assert.equal(result.images[0].mediaType,'image/png');assert.equal(result.images[0].data,PNG);});
});

test('old private cache metadata cannot keep a PNG mislabeled JPEG',async()=>{
 const bytes=Buffer.from(PNG,'base64');const env={DOCS:{async get(){return {size:bytes.length,httpMetadata:{contentType:'image/jpeg'},async arrayBuffer(){return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.length);}};}}};
 await fakeFetch(async()=>{throw Error('cache should suffice');},async()=>{const result=await incomingScreenshots(env,[msg()],at);assert.equal(result.images.length,1);assert.equal(result.images[0].mediaType,'image/png');assert.equal(result.unreadable,0);});
});

test('an HTML error page labeled as an image never reaches vision',async()=>{
 globalThis.__ugcImageRefresh=async()=>null;await fakeFetch(async()=>new Response('<html>error</html>',{headers:{'content-type':'image/jpeg'}}),async()=>{const result=await incomingScreenshots({},[msg()],at);assert.equal(result.images.length,0);assert.equal(result.currentUnavailable,true);});
});
test('all eight recent incoming images stay ordered instead of silently dropping the first two',async()=>{
 const history=[msg({created_at:'2026-10-01T00:00:00Z'}),...Array.from({length:8},(_,i)=>msg({id:String(i),created_at:`2026-10-16T12:0${i}:00Z`}))];
 await fakeFetch(async()=>png(),async()=>{const {images,omitted}=await incomingScreenshots({},history,at);assert.equal(images.length,8);assert.equal(omitted,0);assert.match(images[0].label,/12:00/);assert.match(images.at(-1).label,/12:07/);});
});

test('private archive survives a CDN expiry without downloading the image again',async()=>{
 const objects=new Map();let requests=0;
 const env={DOCS:{async get(k){return objects.get(k)??null;},async put(k,bytes,opts){objects.set(k,{size:bytes.length,httpMetadata:opts.httpMetadata,async arrayBuffer(){return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);}});}}};
 await fakeFetch(async()=>{requests++;return png();},async()=>{assert.equal((await incomingScreenshots(env,[msg()],at)).images.length,1);});
 await fakeFetch(async()=>{requests++;return new Response('',{status:404});},async()=>{const result=await incomingScreenshots(env,[msg()],at);assert.equal(result.images[0].data,PNG);assert.equal(result.unreadable,0);});
 assert.equal(requests,1);assert.equal(objects.size,1);assert.match([...objects.keys()][0],/^ugc\/ig-private\/[a-f0-9]{64}\/0$/);
});
test('an expired earlier image cannot hide a newer readable screenshot',async()=>{
 globalThis.__ugcImageRefresh=async()=>null;
 const old=msg({id:'old'}),fresh=msg({id:'new',created_at:'2026-10-17T00:00:01Z',attachments_json:JSON.stringify([{image_data:{url:url+'&new=1'}}])});
 await fakeFetch(async u=>String(u).includes('new=1')?png():new Response('',{status:404}),async()=>{const result=await incomingScreenshots({},[old,fresh],fresh.created_at);assert.equal(result.images.length,1);assert.equal(result.unreadable,1);assert.match(result.images[0].label,/00:00:01/);});
});

test('an unreadable current screenshot cannot be replaced by a readable old basket',async()=>{
 globalThis.__ugcImageRefresh=async()=>null;
 const history=[msg({id:'old',created_at:'2026-10-16T12:00:00Z',attachments_json:JSON.stringify([{image_data:{url:url+'&old=1'}}])}),msg({direction:'out',created_at:'2026-10-16T13:00:00Z'}),msg()];
 await fakeFetch(async u=>String(u).includes('old=1')?png():new Response('',{status:404}),async()=>{const result=await incomingScreenshots({},history,at);assert.equal(result.images.length,1);assert.equal(result.currentUnavailable,true);});
});

test('a current image excluded by the byte budget remains explicitly pending',async()=>{
 const history=Array.from({length:8},(_,i)=>msg({id:String(i),created_at:`2026-10-16T12:0${i}:00Z`}));
 await fakeFetch(async()=>{const bytes=new Uint8Array(3_000_000);bytes.set([255,216,255]);return new Response(bytes,{headers:{'content-type':'image/jpeg'}});},async()=>{const result=await incomingScreenshots({},history,at);assert.equal(result.omitted,3);assert.equal(result.currentUnavailable,true);});
});
