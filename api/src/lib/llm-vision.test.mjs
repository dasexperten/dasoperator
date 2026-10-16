import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
let build;const require=createRequire(import.meta.url);try{({build}=require('esbuild'));}catch{({build}=createRequire(new URL('../../../workers/package.json',import.meta.url))('esbuild'));}
const dir=mkdtempSync(join(tmpdir(),'llm-vision-')),outfile=join(dir,'llm.mjs');
await build({entryPoints:[fileURLToPath(new URL('./llm.ts',import.meta.url))],outfile,bundle:true,platform:'node',format:'esm'});
const {callVision,callPro}=await import(pathToFileURL(outfile));rmSync(dir,{recursive:true});
const messages=[{role:'system',content:'Read the screenshot.'},{role:'user',content:'Basket',images:[{mediaType:'image/png',data:'fixture',label:'Screenshot at time'}]}];
async function fakeFetch(fn,run){const orig=globalThis.fetch;globalThis.fetch=fn;try{return await run();}finally{globalThis.fetch=orig;}}
test('Anthropic receives image blocks rather than attachment placeholders',async()=>{
 await fakeFetch(async(url,init)=>{assert.match(url,/api.anthropic.com/);const b=JSON.parse(init.body);assert.deepEqual(b.messages[0].content.at(-1),{type:'image',source:{type:'base64',media_type:'image/png',data:'fixture'}});assert.match(b.messages[0].content[1].text,/Screenshot/);return Response.json({content:[{type:'text',text:'Read'}],usage:{input_tokens:1,output_tokens:1}});},async()=>{assert.equal((await callVision(messages,{env:{CLAUDE_CODE_OAUTH_TOKEN:'sk-ant-oat-test'}})).text,'Read');});
});
test('fallback preserves the actual image on a vision-capable model',async()=>{
 const urls=[];await fakeFetch(async(url,init)=>{urls.push(url);if(url.includes('anthropic.com'))return new Response('',{status:503});const b=JSON.parse(init.body);assert.match(url,/openrouter.ai/);assert.match(b.model,/claude-sonnet/);assert.equal(b.messages[1].content.at(-1).image_url.url,'data:image/png;base64,fixture');return Response.json({choices:[{message:{content:'Read'}}]});},async()=>{assert.equal((await callVision(messages,{env:{CLAUDE_CODE_OAUTH_TOKEN:'sk-ant-oat-test',OPENROUTER_ERP:'test'}})).provider,'openrouter');assert.equal(urls.length,2);});
});
test('images cannot silently fall through to a text-only provider',async()=>{
 await assert.rejects(callPro(messages,{env:{DEEPSEEK_API_KEY:'test'}}),/callVision/);
 await assert.rejects(callVision(messages,{env:{DEEPSEEK_API_KEY:'test'}}),/No vision/);
});
