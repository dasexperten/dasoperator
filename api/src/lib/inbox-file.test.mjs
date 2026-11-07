import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(new URL('../../../workers/package.json', import.meta.url));
const { build } = require('esbuild');
const dir = mkdtempSync(join(tmpdir(), 'inbox-file-'));
await build({ entryPoints: [fileURLToPath(new URL('./inbox-file.ts', import.meta.url))], bundle:true, platform:'node', format:'esm', outfile:join(dir,'file.mjs') });
const { serveInboxFile } = await import(pathToFileURL(join(dir,'file.mjs')));
test.after(() => rmSync(dir,{recursive:true,force:true}));
function fixture(row, object) {
  const reads=[];
  return { reads, env: {
    DB:{prepare(sql){assert.match(sql,/deleted_at IS NULL/);return {bind(id){reads.push(['inbox',id]);return {first:async()=>row}}}}},
    DOCS:{get:async key=>{reads.push(['file',key]);return object}},
  }};
}
test('serves the original file by stored inbox identity with private cache and safe filename',async()=>{
  const f=fixture({attachment_r2_key:'telegram_inbox/real.pdf',attachment_filename:'Счёт\r\n1330.pdf',attachment_content_type:'application/pdf'},
    {body:new Uint8Array([37,80,68,70]),httpMetadata:{contentType:'application/pdf'}});
  const r=await serveInboxFile(f.env,'inv_real');assert.equal(r.status,200);
  assert.deepEqual(f.reads,[['inbox','inv_real'],['file','telegram_inbox/real.pdf']]);
  assert.equal(r.headers.get('Content-Type'),'application/pdf');assert.match(r.headers.get('Cache-Control'),/^private/);
  assert.match(r.headers.get('Content-Disposition'),/^inline; filename\*=UTF-8''/);
  assert.doesNotMatch(r.headers.get('Content-Disposition'),/%0D|%0A/);
  assert.deepEqual([...new Uint8Array(await r.arrayBuffer())],[37,80,68,70]);
});
test('missing/deleted inbox or missing source object returns 404 without accepting a caller R2 key',async()=>{
  const absent=fixture(null,null);assert.equal((await serveInboxFile(absent.env,'unknown')).status,404);
  assert.deepEqual(absent.reads,[['inbox','unknown']]);
  const missing=fixture({attachment_r2_key:'stored-key'},null);assert.equal((await serveInboxFile(missing.env,'inv_missing')).status,404);
});
