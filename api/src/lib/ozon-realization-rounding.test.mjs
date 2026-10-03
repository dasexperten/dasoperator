import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require=createRequire(import.meta.url),dir=mkdtempSync(join(tmpdir(),'ozon-rounding-'));
require('esbuild').buildSync({entryPoints:[fileURLToPath(new URL('./marketplace-pull.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',outfile:join(dir,'pull.mjs')});
const {tickMarketplacePull}=await import(pathToFileURL(join(dir,'pull.mjs')));
test.after(()=>rmSync(dir,{recursive:true,force:true}));
function fixture(existing=false) {
  const task={id:'monthly-fixture',marketplace:'ozon',status:'fetched',task_type:'realization',period_from:'2026-09-01',period_to:'2026-09-30'};
  const rows=[{offer_id:'a',qty:3,dc_total:100},{offer_id:'b',qty:2000,dc_total:12501.37},{offer_id:'c',qty:1072,dc_total:-6787.9645}];
  const writes=[];
  const env={DB:{prepare(sql){let args=[];return {bind(...a){args=a;return this;},async first(){
    if(sql.includes('SELECT * FROM marketplace_pull_tasks'))return task;
    if(sql.includes('SELECT id FROM operations'))return existing?{id:'existing'}:null;
    return null;
  },async all(){
    if(sql.includes('FROM ozon_realization_staging'))return {results:rows};
    if(sql.includes('SELECT id FROM products'))return {results:rows.map(r=>({id:r.offer_id}))};
    throw new Error('Unexpected query: '+sql);
  },async run(){writes.push({sql,args});}};},async batch(stmts){for(const s of stmts)await s.run();}}};
  return {env,writes};
}
for(const existing of [false,true])test('monthly Ozon preserves kopecks and negative lines on '+(existing?'refresh':'insert'),async()=>{
  const {env,writes}=fixture(existing);
  assert.equal((await tickMarketplacePull(env)).action,'built');
  const lines=writes.filter(w=>w.sql.includes('INSERT INTO line_items'));
  assert.deepEqual(lines.map(w=>w.args[7]),[100,12501.37,-6787.96]);
  assert.equal(lines[0].args[5],100/3);
  assert.equal(lines[1].args[5],12501.37/2000);
  const op=writes.find(w=>w.sql.includes(existing?'UPDATE operations':'INSERT INTO operations'));
  assert.equal(op.args[existing?1:2],5813.41);
  const pnl=writes.filter(w=>w.sql.includes('INSERT INTO marketplace_pnl_lines'));
  assert.deepEqual(pnl.map(w=>w.args[14]),[100,12501.37,-6787.96]);
  assert.deepEqual(pnl.map(w=>w.args[7]),[100,12501.37,-6787.9645]);
});
