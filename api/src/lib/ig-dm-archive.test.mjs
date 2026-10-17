import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const dir=mkdtempSync(join(tmpdir(),'ig-archive-')),out=join(dir,'archive.mjs');
await build({entryPoints:[fileURLToPath(new URL('./ig-dm-archive.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',outfile:out,
 plugins:[{name:'cache',setup(b){b.onResolve({filter:/ig-dm-image-cache$/},a=>({path:a.path,namespace:'test'}));b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export const cacheIncomingImages=async()=>globalThis.__archivedImages++;'}));}}]});
const {archiveIgMessage}=await import(pathToFileURL(out));rmSync(dir,{recursive:true});
const at='2026-10-17T08:00:00Z',attachments={data:[{image_data:{url:'https://lookaside.fbsbx.com/image'}}]};
function fixture(existing){const rows=new Map(existing?[['message',{attachments_json:null}]]:[]);globalThis.__archivedImages=0;const env={DB:{prepare(sql){let p;const s={bind(...v){p=v;return s;},async run(){if(sql.startsWith('INSERT')){if(rows.has(p[0]))return {meta:{changes:0}};rows.set(p[0],{attachments_json:p[6]});return {meta:{changes:1}};}const row=rows.get(p[0]);if(row&&!row.attachments_json){row.attachments_json=p[1];return {meta:{changes:1}};}return {meta:{changes:0}};}};return s;}}};return {env,rows};}
test('an attachment arriving after its message is recovered even behind the poll cursor',async()=>{const f=fixture(true);const r=await archiveIgMessage(f.env,'conversation',{id:'message',created_time:at,from:{id:'blogger'},attachments},at,Date.parse(at)+60000);assert.equal(r.repaired,true);assert.equal(r.inserted,false);assert.equal(globalThis.__archivedImages,1);assert.match(f.rows.get('message').attachments_json,/image_data/);});
test('re-reading a complete message does not duplicate history, activity or caching',async()=>{const f=fixture(false);const m={id:'message',created_time:at,from:{id:'blogger'},attachments};await archiveIgMessage(f.env,'conversation',m,at,0);const r=await archiveIgMessage(f.env,'conversation',m,at,0);assert.deepEqual(r,{inserted:false,repaired:false,incoming:false});assert.equal(f.rows.size,1);assert.equal(globalThis.__archivedImages,1);});
test('a later empty API response cannot erase an already archived screenshot',async()=>{const f=fixture(false);const m={id:'message',created_time:at,from:{id:'blogger'},attachments};await archiveIgMessage(f.env,'conversation',m,at,0);await archiveIgMessage(f.env,'conversation',{...m,attachments:null},at,0);assert.match(f.rows.get('message').attachments_json,/image_data/);});
