import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require=createRequire(new URL('../../../workers/package.json',import.meta.url));
const {build}=require('esbuild');
const dir=mkdtempSync(join(tmpdir(),'marketplace-fifo-'));
const outfile=join(dir,'fifo.mjs');
await build({entryPoints:[fileURLToPath(new URL('./marketplace-fifo-allocator.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',outfile});
const {planMarketplaceFifoForPartner,runMarketplaceFifoForPartner}=await import(pathToFileURL(outfile));
rmSync(dir,{recursive:true});

function fixture(){
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE partners(id TEXT PRIMARY KEY,tax_id TEXT,currency TEXT,deleted_at INTEGER);
    INSERT INTO partners VALUES('wb','WB-TAX','RUB',NULL);
    CREATE TABLE bank_transactions(id TEXT PRIMARY KEY,amount INTEGER,currency TEXT,executed_at INTEGER,direction TEXT,status TEXT,
      payment_purpose TEXT,contragent_name TEXT,contragent_inn TEXT,external_doc_number TEXT,match_method TEXT,
      matched_operation_id TEXT,matched_payment_id TEXT,matched_by TEXT,matched_at INTEGER,updated_at INTEGER,deleted_at INTEGER,raw_payload TEXT);
    CREATE TABLE operations(id TEXT PRIMARY KEY,reference TEXT,total_amount REAL,currency TEXT,operation_date INTEGER,partner_id TEXT,
      operation_type TEXT,status TEXT,deleted_at INTEGER);
    CREATE TABLE operation_attachments(id TEXT PRIMARY KEY,operation_id TEXT REFERENCES operations(id),source_ref_id TEXT,amount REAL,currency TEXT,
      direction TEXT,kind TEXT,parsed_from TEXT,doc_number TEXT,doc_date INTEGER,issuer TEXT,notes TEXT,created_at INTEGER,updated_at INTEGER,deleted_at INTEGER);
    CREATE TABLE payments(id TEXT PRIMARY KEY,operation_id TEXT,partner_id TEXT,amount REAL,currency TEXT,notes TEXT,deleted_at INTEGER);
    PRAGMA foreign_keys=ON;`);
  const insert=(table,values)=>db.prepare(`INSERT INTO ${table}(${Object.keys(values).join(',')}) VALUES(${Object.keys(values).map(()=>'?').join(',')})`).run(...Object.values(values));
  const bank=(id='bank-001',more={})=>insert('bank_transactions',{id,amount:10000,currency:'RUB',executed_at:1,direction:'incoming',status:'Received',
    payment_purpose:'Marketplace payout',contragent_name:'WB',contragent_inn:'WB-TAX',external_doc_number:'fixture',match_method:'awaiting_marketplace_settlement',
    matched_operation_id:null,matched_payment_id:null,matched_by:null,deleted_at:null,...more});
  const op=(id='sale-001',more={})=>insert('operations',{id,reference:id,total_amount:100,currency:'RUB',operation_date:1,partner_id:'wb',operation_type:'sale',status:'issued',deleted_at:null,...more});
  const attachment=(id,more={})=>insert('operation_attachments',{id,operation_id:'sale-001',source_ref_id:'bank-001',amount:40,currency:'RUB',direction:'incoming',kind:'payment',parsed_from:'bank_tx',notes:'original manual note',deleted_at:null,...more});
  let writes=0,reads=0;
  const prepare=sql=>{const stmt=db.prepare(sql);let args=[];return {bind(...values){args=values;return this;},async all(){reads++;return {results:stmt.all(...args)};},async first(){reads++;return stmt.get(...args)??null;},async run(){writes++;return this.sync();},sync(){const out=stmt.run(...args);return {meta:{changes:Number(out.changes)}};}};};
  const env={DB:{prepare,async batch(statements){if(this.beforeBatch){const hook=this.beforeBatch;this.beforeBatch=null;hook();}writes++;db.exec('BEGIN IMMEDIATE');try{const out=statements.map(s=>s.sync());db.exec('COMMIT');return out;}catch(error){db.exec('ROLLBACK');throw error;}}}};
  return {db,env,bank,op,attachment,insert,readCount:()=>reads,writeCount:()=>writes};
}
async function withFixture(fn){const f=fixture();try{await fn(f);}finally{f.db.close();}}
const run=f=>runMarketplaceFifoForPartner(f.env,'wb');
const plan=f=>planMarketplaceFifoForPartner(f.env,'wb');
const sum=(f,where='1')=>f.db.prepare(`SELECT COALESCE(SUM(amount),0) amount FROM operation_attachments WHERE kind='payment' AND deleted_at IS NULL AND ${where}`).get().amount;

test('read-only plan sees only the positive tail of a matched partial bank transaction',()=>withFixture(async f=>{
  f.bank('bank-001',{match_method:'partially_allocated_marketplace_fifo',matched_operation_id:'old-sale',matched_by:'system_fifo'});
  f.op('old-sale',{total_amount:40});f.op('new-sale',{total_amount:100,operation_date:2});f.attachment('old',{operation_id:'old-sale'});
  const before=f.db.prepare('SELECT * FROM bank_transactions').all();const p=await plan(f);
  assert.equal(p.transactions[0].available_minor,6000);assert.equal(p.allocations[0].amount_minor,6000);assert.equal(p.allocations[0].op.id,'new-sale');
  assert.equal(f.writeCount(),0);assert.ok(f.readCount()<=6);assert.deepEqual(f.db.prepare('SELECT * FROM bank_transactions').all(),before);
}));
test('partial tail is applied once without replacing original payment rows or manual notes',()=>withFixture(async f=>{
  f.bank('bank-001',{match_method:'partially_allocated_marketplace_fifo',matched_operation_id:'old-sale',matched_by:'system_fifo'});
  f.op('old-sale',{total_amount:40});f.op('new-sale',{operation_date:2});f.attachment('old',{operation_id:'old-sale'});
  const before=f.db.prepare("SELECT * FROM operation_attachments WHERE id='old'").get();
  const r=await run(f);assert.equal(r.allocations_created,1);assert.equal(sum(f),100);
  assert.deepEqual(f.db.prepare("SELECT * FROM operation_attachments WHERE id='old'").get(),before);
  assert.equal(f.db.prepare('SELECT match_method FROM bank_transactions').get().match_method,'auto_allocated_marketplace_fifo');
  assert.equal((await run(f)).allocations_created,0);assert.equal(sum(f),100);
}));
test('fully allocated legacy partial is relabelled without allocating the full transaction again',()=>withFixture(async f=>{
  f.bank('bank-001',{match_method:'partially_allocated_marketplace_fifo',matched_operation_id:'sale-001',matched_by:'system_fifo'});f.op();f.attachment('old',{amount:100});
  const r=await run(f);assert.equal(r.allocations_created,0);assert.equal(sum(f),100);assert.equal(r.payments_processed,1);
  assert.equal(f.db.prepare('SELECT match_method FROM bank_transactions').get().match_method,'auto_allocated_marketplace_fifo');
}));
test('overallocated or ambiguous source payments are held, with old attachments and bank labels unchanged',async()=>{
  for(const more of [{amount:101},{currency:'USD'},{amount:1.001},{direction:'outgoing'},{operation_id:null}]){
    await withFixture(async f=>{f.bank('bank-001',{match_method:'partially_allocated_marketplace_fifo',matched_operation_id:'sale-001',matched_by:'system_fifo'});f.op();f.attachment('original',more);
      const before=f.db.prepare('SELECT * FROM operation_attachments').all(),bank=f.db.prepare('SELECT * FROM bank_transactions').all();
      const r=await run(f);assert.equal(r.allocations_created,0);assert.ok(r.review.some(row=>row.scope==='transaction'));
      assert.deepEqual(f.db.prepare('SELECT * FROM operation_attachments').all(),before);assert.deepEqual(f.db.prepare('SELECT * FROM bank_transactions').all(),bank);});
  }
});
test('manual/inbox/webhook payment allocations conserve source cash, while deleted rows are not spent twice',()=>withFixture(async f=>{
  f.bank();f.op('old-sale',{total_amount:30});f.op('new-sale',{operation_date:2});
  f.attachment('manual',{operation_id:'old-sale',amount:30,parsed_from:'manual'});
  f.attachment('deleted',{operation_id:'old-sale',amount:50,deleted_at:1});
  const r=await run(f);assert.equal(r.allocations_created,1);assert.equal(sum(f),100);
  assert.equal(f.db.prepare("SELECT amount FROM operation_attachments WHERE operation_id='new-sale'").get().amount,70);
  assert.equal(f.db.prepare("SELECT deleted_at FROM operation_attachments WHERE id='deleted'").get().deleted_at,1);
}));
test('split allocation uses exact integer cents including the final single kopek',()=>withFixture(async f=>{
  f.bank('bank-001',{amount:10001});f.op('first',{total_amount:33.33});f.op('second',{total_amount:66.67,operation_date:2});f.op('last-cent',{total_amount:0.01,operation_date:3});
  const p=await plan(f);assert.deepEqual(p.allocations.map(a=>a.amount_minor),[3333,6667,1]);
  const r=await run(f);assert.equal(r.allocations_created,3);assert.equal(Math.round(sum(f)*100),10001);assert.equal(r.leftover_amount_major,0);
}));
test('deleted bank/ops, wrong status/currency, manual bank match and fractional operation amounts never allocate',()=>withFixture(async f=>{
  f.bank('deleted',{deleted_at:1});f.bank('pending',{status:'Pending'});f.bank('wrong-currency',{currency:'USD'});
  f.bank('manual',{match_method:'partially_allocated_marketplace_fifo',matched_by:'human'});
  f.op('deleted',{deleted_at:1});f.op('cancelled',{status:'cancelled'});f.op('wrong-currency',{currency:'USD'});f.op('fractional',{total_amount:0.001});
  const r=await run(f);assert.equal(r.allocations_created,0);assert.equal(sum(f),0);
  assert.ok(r.review.some(row=>row.reason==='manual_bank_match'));assert.ok(r.review.some(row=>row.reason==='invalid_operation_minor_units'));
}));
test('target legacy payments and legacy settlement on an already allocated operation hold the entire source tail',async()=>{
  await withFixture(async f=>{f.bank();f.op();f.insert('payments',{id:'legacy',operation_id:'sale-001',partner_id:'wb',amount:100,currency:'RUB',notes:'virtual settlement',deleted_at:null});
    const r=await run(f);assert.equal(r.allocations_created,0);assert.ok(r.review.some(row=>row.reason==='legacy_operation_settlement_requires_review'));});
  await withFixture(async f=>{f.bank('bank-001',{match_method:'partially_allocated_marketplace_fifo',matched_operation_id:'old-sale',matched_by:'system_fifo'});f.op('old-sale',{total_amount:40});f.op('new-sale',{operation_date:2});f.attachment('old',{operation_id:'old-sale'});
    f.insert('payments',{id:'legacy',operation_id:'old-sale',partner_id:'wb',amount:40,currency:'RUB',notes:'virtual',deleted_at:null});
    const r=await run(f);assert.equal(r.allocations_created,0);assert.equal(sum(f),40);assert.ok(r.review.some(row=>row.reason==='legacy_allocated_operation_requires_review'));});
});
test('a legacy bank ID in notes is a hold, not a second amount to sum or a link to rewrite',()=>withFixture(async f=>{
  f.bank();f.op();f.insert('payments',{id:'legacy',operation_id:null,partner_id:'wb',amount:100,currency:'RUB',notes:'AUTO-MATCH bank-001',deleted_at:null});
  const r=await run(f);assert.equal(r.allocations_created,0);assert.ok(r.review.some(row=>row.reason==='legacy_bank_settlement_requires_review'));
}));
test('two simultaneous manual/cron/pipeline runs cannot double-spend source cash or operation capacity',()=>withFixture(async f=>{
  f.bank();f.op('first',{total_amount:40});f.op('second',{total_amount:60,operation_date:2});
  const results=await Promise.all([run(f),run(f),run(f)]);assert.equal(results.reduce((n,r)=>n+r.allocations_created,0),2);
  assert.equal(sum(f),100);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM operation_attachments').get().n,2);
  assert.equal(f.db.prepare('SELECT match_method FROM bank_transactions').get().match_method,'auto_allocated_marketplace_fifo');
}));
test('a manual source allocation or legacy target payment arriving after planning defeats stale inserts',async()=>{
  await withFixture(async f=>{f.bank();f.op();f.env.DB.beforeBatch=()=>f.attachment('manual',{amount:40,parsed_from:'manual'});
    const r=await run(f);assert.equal(r.allocations_created,0);assert.equal(r.stale_allocations,1);assert.equal(sum(f),40);});
  await withFixture(async f=>{f.bank();f.op();f.env.DB.beforeBatch=()=>f.insert('payments',{id:'manual',operation_id:'sale-001',partner_id:'wb',amount:100,currency:'RUB',deleted_at:null});
    const r=await run(f);assert.equal(r.allocations_created,0);assert.equal(sum(f),0);});
});
test('failure updating bank status rolls back the new attachment; retry is safe',()=>withFixture(async f=>{
  f.bank();f.op();f.db.exec("CREATE TRIGGER fail_bank BEFORE UPDATE ON bank_transactions BEGIN SELECT RAISE(ABORT,'fixture bank write failure'); END");
  await assert.rejects(run(f),/fixture bank write failure/);assert.equal(sum(f),0);
  f.db.exec('DROP TRIGGER fail_bank');assert.equal((await run(f)).allocations_created,1);assert.equal(sum(f),100);
}));
test('crash between split batches preserves the committed partial and retries only its tail',()=>withFixture(async f=>{
  f.bank();f.op('first',{total_amount:40});f.op('second',{total_amount:60,operation_date:2});
  const batch=f.env.DB.batch.bind(f.env.DB);let calls=0;f.env.DB.batch=async statements=>{if(++calls===2)throw Error('fixture crash');return batch(statements);};
  await assert.rejects(run(f),/fixture crash/);assert.equal(sum(f),40);
  assert.equal(f.db.prepare('SELECT match_method FROM bank_transactions').get().match_method,'partially_allocated_marketplace_fifo');
  f.env.DB.batch=batch;assert.equal((await run(f)).allocations_created,1);assert.equal(sum(f),100);
}));

test('bank pointer/method/actor CAS protects associations changed after the preview snapshot',async()=>{
  for(const mutation of [
    "matched_operation_id='manual-target',match_method='manual',matched_by='human'",
    "matched_operation_id='other-system-target'",
    "matched_by='human'",
  ])await withFixture(async f=>{
    f.bank('bank-001',{match_method:'partially_allocated_marketplace_fifo',matched_operation_id:'old-sale',matched_by:'system_fifo'});
    f.op('old-sale',{total_amount:40});f.op('new-sale',{operation_date:2});f.attachment('old',{operation_id:'old-sale'});
    f.env.DB.beforeBatch=()=>f.db.exec(`UPDATE bank_transactions SET ${mutation} WHERE id='bank-001'`);
    const r=await run(f);assert.equal(r.allocations_created,0);assert.equal(r.stale_allocations,1);assert.equal(sum(f),40);
    const tx=f.db.prepare('SELECT matched_operation_id,match_method,matched_by FROM bank_transactions').get();
    if(mutation.startsWith("matched_operation_id='other"))assert.equal(tx.matched_operation_id,'other-system-target');
    else assert.equal(tx.matched_by,'human');
  });
});
test('preview never exports raw bank payloads and reports ambiguous held cash as unknown',()=>withFixture(async f=>{
  f.bank('bank-001',{raw_payload:'private provider payload',match_method:'partially_allocated_marketplace_fifo',matched_operation_id:'sale-001',matched_by:'system_fifo'});
  f.op();f.attachment('old',{amount:40});
  const p=await plan(f);assert.equal(JSON.stringify(p).includes('private provider payload'),false);
  f.insert('payments',{id:'legacy',operation_id:'sale-001',partner_id:'wb',amount:100,currency:'RUB',notes:'virtual settlement',deleted_at:null});
  const r=await run(f);assert.equal(r.review_transactions,1);assert.equal(r.leftover_amount_major,null);
  assert.equal(r.known_leftover_amount_major,0);assert.equal(r.allocations_created,0);
}));
test('legacy cause takes precedence over historical binary float artifacts; no amounts are normalized',()=>withFixture(async f=>{
  f.bank('bank-001',{match_method:'partially_allocated_marketplace_fifo',matched_operation_id:'old-sale',matched_by:'system_fifo'});
  f.op('old-sale',{total_amount:40});f.op('new-sale',{operation_date:2});f.attachment('old',{operation_id:'old-sale',amount:40.00000000001});
  f.insert('payments',{id:'legacy',operation_id:'old-sale',partner_id:'wb',amount:40,currency:'RUB',notes:'virtual',deleted_at:null});
  const before=f.db.prepare('SELECT * FROM operation_attachments').all();
  const p=await plan(f);assert.equal(p.review.find(row=>row.scope==='transaction').reason,'legacy_allocated_operation_requires_review');
  assert.equal(p.transactions[0].available_minor,null);assert.deepEqual(f.db.prepare('SELECT * FROM operation_attachments').all(),before);
}));
test('two different bank transactions cannot concurrently exceed one operation capacity',()=>withFixture(async f=>{
  f.bank('bank-001');f.bank('bank-002',{executed_at:2});f.op();
  await Promise.all([run(f),run(f)]);assert.equal(sum(f),100);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM bank_transactions WHERE match_method='auto_allocated_marketplace_fifo'").get().n,1);
}));


test('NULL currency or direction introduced after planning defeats the ledger guard without changing the bank',async()=>{
  for(const column of ['currency','direction'])await withFixture(async f=>{
    f.bank('bank-001',{match_method:'partially_allocated_marketplace_fifo',matched_operation_id:'old-sale',matched_by:'system_fifo'});
    f.op('old-sale',{total_amount:40});f.op('new-sale',{operation_date:2});f.attachment('old',{operation_id:'old-sale'});
    const bankBefore=f.db.prepare('SELECT * FROM bank_transactions').all();
    f.env.DB.beforeBatch=()=>f.db.exec(`UPDATE operation_attachments SET ${column}=NULL WHERE id='old'`);
    const result=await run(f);assert.equal(result.allocations_created,0);assert.equal(result.stale_allocations,1);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM operation_attachments').get().n,1);
    assert.deepEqual(f.db.prepare('SELECT * FROM bank_transactions').all(),bankBefore);
    assert.equal(f.db.prepare("SELECT amount FROM operation_attachments WHERE id='old'").get().amount,40);
  });
});
