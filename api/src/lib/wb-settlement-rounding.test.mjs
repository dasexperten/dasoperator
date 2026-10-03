import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
const require=createRequire(import.meta.url), dir=mkdtempSync(join(tmpdir(),'wb-rounding-'));
require('esbuild').buildSync({entryPoints:[fileURLToPath(new URL('./wb-settlement-rounding.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',outfile:join(dir,'repair.mjs')});
const {reconcileWbSettlementRounding:repair}=await import(pathToFileURL(join(dir,'repair.mjs')));
test.after(()=>rmSync(dir,{recursive:true,force:true}));
const id='op_wb_260927_weekly';
function fixture(t) {
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
  sql.exec(`CREATE TABLE operations(id TEXT,partner_id TEXT,currency TEXT,total_amount REAL,updated_at INTEGER,deleted_at INTEGER);
    CREATE TABLE payments(operation_id TEXT,deleted_at INTEGER);
    CREATE TABLE documents(operation_id TEXT);
    CREATE TABLE line_items(id TEXT,operation_id TEXT,product_id TEXT,qty INTEGER,unit_price REAL,unit_price_after_disc REAL,line_amount REAL,discount_pct REAL,updated_at INTEGER);
    CREATE TABLE marketplace_pnl_lines(id TEXT,operation_id TEXT,marketplace TEXT,product_id TEXT,qty INTEGER,net_total REAL,net_per REAL);
    INSERT INTO operations VALUES('${id}','wb','RUB',99,1,NULL);
    INSERT INTO line_items VALUES('line','${id}','A',3,33,33,99,0,1);
    INSERT INTO marketplace_pnl_lines VALUES('pnl','${id}','wb','A',3,100,33);`);
  let beforeBatch=()=>{};
  const db={prepare(text) {let args=[];return {bind(...a){args=a;return this;},async first(){return sql.prepare(text).get(...args);},execute(){return sql.prepare(text).all(...args);}};},
    async batch(statements){beforeBatch();sql.exec('BEGIN');try {const r=statements.map(s=>s.execute());sql.exec('COMMIT');return r;}catch(e){sql.exec('ROLLBACK');throw e;}}};
  return {sql,db,mutateBeforeBatch(fn){beforeBatch=fn;}};
}
test('repairs the stored operation and lines, preserves source net, and is idempotent',async t=>{
  const {sql,db}=fixture(t);
  assert.deepEqual(await repair(db,id),{operation_id:id,changed:true,before_rub:99,after_rub:100,lines:1});
  assert.equal(sql.prepare('SELECT total_amount FROM operations').get().total_amount,100);
  assert.equal(sql.prepare('SELECT line_amount FROM line_items').get().line_amount,100);
  assert.equal(sql.prepare('SELECT net_total FROM marketplace_pnl_lines').get().net_total,100);
  assert.equal((await repair(db,id)).changed,false);
});
test('negative source lines retain kopecks',async t=>{
  const {sql,db}=fixture(t);
  sql.exec(`UPDATE marketplace_pnl_lines SET net_total=-10.12,net_per=-3;UPDATE line_items SET unit_price=-3,unit_price_after_disc=-3,line_amount=-9;UPDATE operations SET total_amount=-9;`);
  assert.equal((await repair(db,id)).after_rub,-10.12);
});
test('linked payments, issued documents and manually changed lines are not rewritten',async t=>{
  for(const change of [`INSERT INTO payments VALUES('${id}',NULL)`,`INSERT INTO documents VALUES('${id}')`,`UPDATE line_items SET unit_price=34`]) {
    const {sql,db}=fixture(t);sql.exec(change);
    await assert.rejects(()=>repair(db,id));
    assert.equal(sql.prepare('SELECT total_amount FROM operations').get().total_amount,99);
  }
});
test('a change between preflight and transaction aborts every write',async t=>{
  const {sql,db,mutateBeforeBatch}=fixture(t);
  mutateBeforeBatch(()=>sql.exec(`INSERT INTO documents VALUES('${id}')`));
  await assert.rejects(()=>repair(db,id));
  assert.equal(sql.prepare('SELECT total_amount FROM operations').get().total_amount,99);
  assert.equal(sql.prepare('SELECT line_amount FROM line_items').get().line_amount,99);
  assert.equal(sql.prepare('SELECT net_per FROM marketplace_pnl_lines').get().net_per,33);
});
test('a failed later update rolls back already executed financial writes',async t=>{
  const {sql,db}=fixture(t);
  sql.exec(`CREATE TRIGGER reject_pnl BEFORE UPDATE ON marketplace_pnl_lines BEGIN SELECT RAISE(ABORT,'fixture failure'); END;`);
  await assert.rejects(()=>repair(db,id));
  assert.equal(sql.prepare('SELECT total_amount FROM operations').get().total_amount,99);
  assert.equal(sql.prepare('SELECT line_amount FROM line_items').get().line_amount,99);
});
