import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const require=createRequire(import.meta.url);
const dir=mkdtempSync(join(tmpdir(),'mail-backfill-'));
const outfile=join(dir,'route.mjs');
await require('esbuild').build({
  entryPoints:[fileURLToPath(new URL('./email-resend.ts',import.meta.url))],
  bundle:true,platform:'node',format:'esm',outfile,
  plugins:[{name:'mail-index-fixtures',setup(build){
    build.onResolve({filter:/^\.\/mail-index-sync$/},()=>({path:'index',namespace:'fixture'}));
    build.onResolve({filter:/^\.\/email-link$/},()=>({path:'link',namespace:'fixture'}));
    build.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path==='index'
      ? 'export async function recordMailIndexRow(env,addr,row){env.index.push(row);return true;} export function indexWriteMode(){return "snapshot";} export async function mailboxSnapshotReady(){return true;}'
      : 'export async function linkEmail(){}'}));
  }}],
});
const {default:route}=await import(pathToFileURL(outfile));
rmSync(dir,{recursive:true});

test('archive-only backfill retains thread and real attachment bytes; retries cannot erase them or resend',async()=>{
  const objects=new Map();
  const env={EMAILER_SERVICE_SECRET:'fixture-secret',index:[],ARCHIVE:{
    async get(key){const value=objects.get(key);return value===undefined?null:{json:async()=>JSON.parse(value),text:async()=>value};},
    async put(key,value){objects.set(key,value);return {key};},
  }};
  const payload={from:'logistics@dasexperten.com',to:['recipient@example.com'],subject:'Existing delivery',text:'Existing message with its completed spreadsheet attached.',messageId:'existing-delivery-id',in_reply_to:'<parent@example.com>',reply_to_tag:'thread123',attachments:[{filename:'table.xlsx',content:Buffer.from([0,1,2,255]).toString('base64'),contentType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}]};
  const call=body=>route.request('https://fixture/archive-sent',{method:'POST',headers:{'Content-Type':'application/json','X-Emailer-Service-Secret':'fixture-secret'},body:JSON.stringify(body)},env);
  const previousFetch=globalThis.fetch;let networkCalls=0;
  globalThis.fetch=async()=>{networkCalls++;throw Error('Archive backfill must not send mail');};
  try{
    const first=await call(payload);assert.equal(first.status,200);assert.deepEqual(await first.json(),{success:true,archived:1,failed:0,errors:[]});
    const key=[...objects.keys()].find(k=>k.endsWith('.json'));
    const stored=JSON.parse(objects.get(key));
    assert.equal(stored.threadId,payload.in_reply_to);assert.equal(stored.plusTag,payload.reply_to_tag);
    assert.equal(stored.attachments.length,1);assert.equal(stored.attachments[0].size,4);
    assert.equal(stored.attachments[0].mimeType,payload.attachments[0].contentType);
    assert.deepEqual(new Uint8Array(objects.get(stored.attachments[0].key)),new Uint8Array([0,1,2,255]));
    assert.equal(env.index.at(-1).attachmentCount,1);
    const {attachments,in_reply_to,reply_to_tag,...retry}=payload;
    const second=await call(retry);assert.equal((await second.json()).archived,1);
    const restored=JSON.parse(objects.get(key));
    assert.deepEqual(restored.attachments,stored.attachments);assert.equal(restored.threadId,stored.threadId);assert.equal(restored.plusTag,stored.plusTag);assert.equal(restored.timestamp,stored.timestamp);
    assert.equal(env.index.at(-1).attachmentCount,1);assert.equal(networkCalls,0);
  }finally{globalThis.fetch=previousFetch;}
});
