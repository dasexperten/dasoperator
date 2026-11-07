import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runLubertsyInvoices, parseSingleInvoice } from './lubertsy-invoices.mjs';

const at = Date.parse('2026-11-05T00:00:00Z') / 1000;
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE operations(id TEXT PRIMARY KEY,operation_date INTEGER,operation_type TEXT,partner_id TEXT,
      our_company_id TEXT,currency TEXT,total_amount REAL,status TEXT,operation_track TEXT,delivery_status TEXT,
      vat_rate INTEGER,dei_layer INTEGER,via_dei INTEGER,reference TEXT,notes TEXT,created_at INTEGER,updated_at INTEGER,deleted_at INTEGER);
    CREATE TABLE invoice_inbox(id TEXT PRIMARY KEY,matched_partner_id TEXT,classification TEXT,
      extracted_vendor_inn TEXT,extracted_vendor_name TEXT,extracted_invoice_no TEXT,extracted_invoice_date TEXT,
      extracted_currency TEXT,extracted_amount REAL,attachment_r2_key TEXT,created_operation_id TEXT,
      status TEXT CHECK(status IN ('queued','processed','auto_created','auto_attached','needs_partner_link','needs_review','manual_confirmed','manual_rejected','error')),
      processed_at INTEGER,resolved_at INTEGER,deleted_at INTEGER);
    CREATE TABLE operation_attachments(id TEXT PRIMARY KEY,operation_id TEXT REFERENCES operations(id),direction TEXT,kind TEXT,
      doc_number TEXT,doc_date INTEGER,amount REAL,currency TEXT,issuer TEXT,file_url TEXT,parsed_from TEXT,source_ref_id TEXT,
      notes TEXT,created_at INTEGER,updated_at INTEGER,deleted_at INTEGER);
    CREATE TABLE bank_transactions(id TEXT PRIMARY KEY,contragent_inn TEXT,direction TEXT,status TEXT,currency TEXT,amount INTEGER,
      executed_at INTEGER,payment_purpose TEXT,external_doc_number TEXT,contragent_name TEXT,matched_operation_id TEXT,
      matched_payment_id TEXT,match_method TEXT,matched_at INTEGER,matched_by TEXT,updated_at INTEGER,deleted_at INTEGER);
    PRAGMA foreign_keys=ON;
  `);
  const insert = (table, values) => db.prepare(`INSERT INTO ${table}(${Object.keys(values).join(',')}) VALUES(${Object.keys(values).map(()=>'?').join(',')})`).run(...Object.values(values));
  const inbox = (id, more={}) => insert('invoice_inbox',{id,matched_partner_id:'f4_lubertsy',classification:'service',extracted_vendor_inn:'550412856773',
    extracted_vendor_name:'Fixture F4',extracted_invoice_no:'14/218',extracted_invoice_date:'2026-11-05',extracted_currency:'RUB',
    extracted_amount:10257.45,attachment_r2_key:`telegram_inbox/${id}.pdf`,created_operation_id:null,status:'needs_partner_link',deleted_at:null,...more});
  const op = (id,more={}) => insert('operations',{id,operation_date:at,operation_type:'service',partner_id:'f4_lubertsy',our_company_id:'dee',currency:'RUB',total_amount:10257.45,
    status:'issued',operation_track:'service',reference:'LBR-20261105-14/218',notes:'Human note: preserve',deleted_at:null,...more});
  const bank = (id,more={}) => insert('bank_transactions',{id,contragent_inn:'550412856773',direction:'outgoing',status:'Executed',currency:'RUB',amount:1025745,
    executed_at:at+86400,payment_purpose:'Оплата по счету № 14/218 от 05.11.2026 за услуги',external_doc_number:'pay-fixture',contragent_name:'F4',
    matched_operation_id:null,matched_payment_id:null,deleted_at:null,...more});
  const wrap = sql => {
    const stmt=db.prepare(sql);let args=[];
    return {bind(...values){args=values;return this;},async all(){return {results:stmt.all(...args)};},async first(){return stmt.get(...args)??null;},async run(){return this.sync();},sync(){const out=stmt.run(...args);return {meta:{changes:Number(out.changes)}};}};
  };
  const env={DOCS:{async head(key){return {key,size:100};}},DB:{prepare:wrap,async batch(statements){if(this.beforeBatch){const hook=this.beforeBatch;this.beforeBatch=null;hook();}db.exec('BEGIN IMMEDIATE');try{const result=statements.map(s=>s.sync());db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}}};
  return {db,env,inbox,op,bank,insert};
}
async function withFixture(fn){const f=fixture();try{await fn(f);}finally{f.db.close();}}

// Real SQLite constraints / transactions exercise the old invalid status, amount
// scale, document linkage, concurrent claims and rollback rather than mocks.
test('single invoice identity keeps slash and date; multi-invoice, partial and invalid dates are held',()=>{
  assert.equal(parseSingleInvoice('Счет N14/218 от 5.11.26 за услуги').ref,'LBR-20261105-14/218');
  for(const text of ['Оплата №14/218 без даты','счет №1 от 05.11.2026 и №2 от 06.11.2026','счет №1,2 от 05.11.2026',
    'частичная оплата счет №1 от 05.11.2026','счет №1 от 31.02.2026'])assert.equal(parseSingleInvoice(text),null,text);
});
test('new invoice atomically creates one operation with a real file relation and supported inbox status',()=>withFixture(async f=>{
  f.inbox('inv');const result=await runLubertsyInvoices(f.env);assert.deepEqual(result.errors,[]);
  assert.equal(result.opsCreated,1);assert.equal(result.opsLinked,1);
  const op=f.db.prepare('SELECT * FROM operations').get();assert.equal(op.total_amount,10257.45);assert.equal(op.status,'issued');
  const doc=f.db.prepare('SELECT * FROM operation_attachments').get();assert.equal(doc.operation_id,op.id);assert.equal(doc.kind,'invoice');
  assert.equal(doc.file_url,'https://dasoperator-api.dasexperten.workers.dev/api/inbox/inv/file');
  assert.equal(f.db.prepare('SELECT status FROM invoice_inbox').get().status,'auto_attached');
  const again=await runLubertsyInvoices(f.env);assert.equal(again.opsCreated+again.opsLinked,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM operation_attachments').get().n,1);
}));
test('exact existing invoice links and acceptance attaches as act without a second expense',()=>withFixture(async f=>{
  f.op('existing');f.inbox('invoice');f.inbox('act',{classification:'acceptance'});
  const before=f.db.prepare('SELECT * FROM operations').get();const result=await runLubertsyInvoices(f.env);
  assert.deepEqual(result.errors,[]);assert.equal(result.opsCreated,0);assert.equal(result.opsLinked,2);
  assert.deepEqual(f.db.prepare('SELECT * FROM operations').get(),before);
  assert.deepEqual(f.db.prepare('SELECT kind FROM operation_attachments ORDER BY kind').all().map(r=>r.kind),['act','invoice']);
}));
test('bank draft converts kopeks once, links debit and payment evidence; rerun does not duplicate',()=>withFixture(async f=>{
  f.bank('tx');const result=await runLubertsyInvoices(f.env);assert.deepEqual(result.errors,[]);assert.equal(result.opsCreated,1);assert.equal(result.paymentsMatched,1);
  const op=f.db.prepare('SELECT * FROM operations').get();assert.equal(op.total_amount,10257.45);assert.equal(op.status,'draft');
  const payment=f.db.prepare('SELECT * FROM operation_attachments').get();assert.equal(payment.amount,10257.45);assert.equal(payment.kind,'payment');
  assert.equal(f.db.prepare('SELECT matched_operation_id FROM bank_transactions').get().matched_operation_id,op.id);
  const again=await runLubertsyInvoices(f.env);assert.equal(again.opsCreated+again.paymentsMatched,0);
}));
test('exact bank links existing operation; later invoice supplies PDF without rewriting money or notes',()=>withFixture(async f=>{
  f.bank('tx');await runLubertsyInvoices(f.env);const before=f.db.prepare('SELECT * FROM operations').get();
  f.inbox('later');const result=await runLubertsyInvoices(f.env);assert.equal(result.opsCreated,0);assert.equal(result.opsLinked,1);
  assert.deepEqual(f.db.prepare('SELECT * FROM operations').get(),before);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM operation_attachments').get().n,2);
}));
test('number alone never assigns another vendor orphan, and same invoice number next year remains separate',()=>withFixture(async f=>{
  f.op('last-year',{reference:'LBR-20251105-14/218',operation_date:at-365*86400});
  f.inbox('unknown',{matched_partner_id:null,extracted_vendor_inn:null});
  f.inbox('wrong-vendor',{matched_partner_id:null,extracted_vendor_inn:'another-vendor'});
  f.inbox('exact-inn',{matched_partner_id:null});
  const result=await runLubertsyInvoices(f.env);assert.deepEqual(result.errors,[]);assert.equal(result.opsCreated,1);assert.equal(result.opsLinked,1);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM invoice_inbox WHERE created_operation_id IS NULL").get().n,2);
}));
test('date/ref legacy conflicts, cancelled/deleted operations and old 100x total are never rewritten or duplicated',async()=>{
  for(const fields of [{reference:'LBR-20261106-14/218'},{reference:'LBR-20261105-14218'},{status:'cancelled'},{deleted_at:1},{total_amount:1025745}]){
    await withFixture(async f=>{f.op('old',fields);f.inbox('inv');f.bank('tx');const before=f.db.prepare('SELECT * FROM operations').get();
      const result=await runLubertsyInvoices(f.env);assert.equal(result.ok,true);assert.deepEqual(result.errors,[]);assert.equal(result.review_required,2);assert.ok(result.skipped.every(row=>row.review_required===true));assert.equal(result.opsCreated,0);assert.equal(result.paymentsMatched,0);
      assert.deepEqual(f.db.prepare('SELECT * FROM operations').get(),before);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM operation_attachments').get().n,0);});
  }
});
test('conflicting amounts and duplicate exact operations are held without choosing MAX or first',async()=>{
  await withFixture(async f=>{f.inbox('a');f.inbox('b',{extracted_amount:1});const result=await runLubertsyInvoices(f.env);assert.equal(result.opsCreated,0);assert.equal(result.ok,true);assert.equal(result.review_required,2);assert.deepEqual(result.errors,[]);});
  await withFixture(async f=>{f.op('a');f.op('b');f.inbox('invoice');const result=await runLubertsyInvoices(f.env);assert.equal(result.opsLinked,0);assert.equal(result.ok,true);assert.equal(result.review_required,1);assert.equal(result.skipped[0].review_required,true);assert.deepEqual(result.errors,[]);});
});
test('deleted/resolved documents, foreign currency, incoming/pending/allocated and multi-invoice banks are not touched',()=>withFixture(async f=>{
  for(const [id,more] of [['del',{deleted_at:1}],['rejected',{status:'manual_rejected'}],['confirmed',{status:'manual_confirmed'}],['currency',{extracted_currency:'USD'}],['file',{attachment_r2_key:null}],['act',{classification:'acceptance'}]])f.inbox(id,more);
  for(const [id,more] of [['del',{deleted_at:1}],['currency',{currency:'USD'}],['incoming',{direction:'incoming'}],['pending',{status:'Pending'}],['allocated',{matched_payment_id:'payment-old'}],['multiple',{payment_purpose:'счет №1 от 05.11.2026 и №2 от 05.11.2026'}],['nodate',{payment_purpose:'счет №14/218'}]])f.bank(id,more);
  const result=await runLubertsyInvoices(f.env);assert.equal(result.opsCreated+result.opsLinked+result.paymentsMatched,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM operations').get().n,0);
}));
test('two concurrent sweeps create, attach and match the same invoice only once',()=>withFixture(async f=>{
  f.inbox('inv');f.bank('tx');const results=await Promise.all([runLubertsyInvoices(f.env),runLubertsyInvoices(f.env)]);
  assert.deepEqual(results.flatMap(r=>r.errors),[]);assert.equal(results.reduce((sum,r)=>sum+r.opsCreated,0),1);
  assert.equal(results.reduce((sum,r)=>sum+r.opsLinked,0),1);assert.equal(results.reduce((sum,r)=>sum+r.paymentsMatched,0),1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM operations').get().n,1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM operation_attachments').get().n,2);
}));
test('attachment insert failure rolls back operation and inbox resolution, allowing safe retry',()=>withFixture(async f=>{
  f.inbox('inv');f.db.exec("CREATE TRIGGER broken_attachment BEFORE INSERT ON operation_attachments BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END");
  const result=await runLubertsyInvoices(f.env);assert.equal(result.ok,false);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM operations').get().n,0);
  assert.equal(f.db.prepare('SELECT status FROM invoice_inbox').get().status,'needs_partner_link');
  f.db.exec('DROP TRIGGER broken_attachment');assert.equal((await runLubertsyInvoices(f.env)).opsCreated,1);
}));

test('stored file key without an actual archived object never creates or resolves an invoice',()=>withFixture(async f=>{
  f.inbox('missing');f.env.DOCS.head=async()=>null;
  const result=await runLubertsyInvoices(f.env);assert.equal(result.opsCreated+result.opsLinked,0);
  assert.equal(result.skipped[0].reason,'invoice_file_not_available');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM operations').get().n,0);
  assert.equal(f.db.prepare('SELECT status FROM invoice_inbox').get().status,'needs_partner_link');
}));
test('document and bank resolved by another caller before batch do not leave empty new operations',async()=>{
  await withFixture(async f=>{f.inbox('stale');f.env.DB.beforeBatch=()=>f.db.prepare("UPDATE invoice_inbox SET status='manual_rejected' WHERE id='stale'").run();
    const result=await runLubertsyInvoices(f.env);assert.equal(result.opsCreated+result.opsLinked,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM operations').get().n,0);});
  await withFixture(async f=>{f.bank('stale');f.env.DB.beforeBatch=()=>f.db.prepare("UPDATE bank_transactions SET matched_payment_id='human-payment' WHERE id='stale'").run();
    const result=await runLubertsyInvoices(f.env);assert.equal(result.opsCreated+result.paymentsMatched,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM operations').get().n,0);});
});
test('a second debit cannot automatically double-settle the same invoice',()=>withFixture(async f=>{
  f.bank('a');f.bank('b');const result=await runLubertsyInvoices(f.env);assert.equal(result.opsCreated,1);assert.equal(result.paymentsMatched,1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM bank_transactions WHERE matched_operation_id IS NOT NULL').get().n,1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM operation_attachments').get().n,1);
}));


test('empty archived object is not invoice evidence',()=>withFixture(async f=>{
  f.inbox('empty');f.env.DOCS.head=async()=>({size:0});
  const result=await runLubertsyInvoices(f.env);assert.equal(result.opsCreated+result.opsLinked,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM operations').get().n,0);
}));
test('inbox reclassified before attachment batch cannot be linked using stale classification',()=>withFixture(async f=>{
  f.op('existing');f.inbox('stale');
  f.env.DB.beforeBatch=()=>f.db.prepare("UPDATE invoice_inbox SET classification='purchase' WHERE id='stale'").run();
  const result=await runLubertsyInvoices(f.env);assert.equal(result.opsLinked,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM operation_attachments').get().n,0);
  assert.equal(f.db.prepare('SELECT status FROM invoice_inbox').get().status,'needs_partner_link');
}));


test('amount review is a successful bounded hold; technical DB failure remains a failed run',async()=>{
  await withFixture(async f=>{
    f.op('manual',{total_amount:1025745});f.bank('tx');
    const before=f.db.prepare('SELECT * FROM operations').all();
    const result=await runLubertsyInvoices(f.env);
    assert.equal(result.ok,true);assert.equal(result.review_required,1);assert.deepEqual(result.errors,[]);
    assert.equal(result.skipped[0].id,'tx');assert.equal(result.skipped[0].review_required,true);
    assert.match(result.skipped[0].reason,/amount conflict/);
    assert.equal(f.db.prepare('SELECT matched_operation_id FROM bank_transactions').get().matched_operation_id,null);
    assert.deepEqual(f.db.prepare('SELECT * FROM operations').all(),before);
  });
  await withFixture(async f=>{
    f.inbox('invoice');const prepare=f.env.DB.prepare;
    f.env.DB.prepare=sql=>{if(sql.includes('SELECT o.* FROM operations'))throw Error('injected DB unavailable');return prepare(sql);};
    const result=await runLubertsyInvoices(f.env);
    assert.equal(result.ok,false);assert.equal(result.review_required,0);assert.equal(result.errors.length,1);
    assert.match(result.errors[0],/injected DB unavailable/);assert.equal(result.skipped.length,0);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM operations').get().n,0);
    assert.equal(f.db.prepare('SELECT status FROM invoice_inbox').get().status,'needs_partner_link');
  });
});
