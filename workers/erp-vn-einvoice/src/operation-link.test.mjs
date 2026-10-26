import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { mkdtempSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir=mkdtempSync(join(tmpdir(),'vn-operation-'));
const bundle=await build({entryPoints:[new URL('./operation-link.ts',import.meta.url).pathname],bundle:true,platform:'node',format:'esm',write:false});
writeFileSync(join(dir,'link.mjs'),bundle.outputFiles[0].text);
const {linkManualOperation,syncManualOperation}=await import(join(dir,'link.mjs'));
test.after(()=>rmSync(dir,{recursive:true,force:true}));
const migration=n=>readFileSync(new URL(`../../../db/migrations/${n}`,import.meta.url),'utf8');
function fixture() {
 const sql=new DatabaseSync(':memory:');
 sql.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE companies(id TEXT PRIMARY KEY); INSERT INTO companies VALUES('dasean');
 CREATE TABLE manufacturers(id TEXT PRIMARY KEY); CREATE TABLE warehouses(id TEXT PRIMARY KEY);
 CREATE TABLE price_types(id TEXT PRIMARY KEY); CREATE TABLE contracts(id TEXT PRIMARY KEY); CREATE TABLE operation_batches(id TEXT PRIMARY KEY);
 CREATE TABLE partners(id TEXT PRIMARY KEY,trade_name TEXT,legal_name TEXT,country TEXT,tax_id TEXT,address TEXT,registered_address_local TEXT,currency TEXT,partner_type TEXT,kind TEXT,status TEXT,created_at INTEGER,updated_at INTEGER,notes TEXT,deleted_at INTEGER);
 CREATE TABLE products(id TEXT PRIMARY KEY,deleted_at INTEGER); INSERT INTO products VALUES('de203',NULL),('de210',NULL);`);
 const opDDL=migration('0043_operation_type_service_tax.sql').match(/CREATE TABLE "operations_new" \([\s\S]*?\n\);/)[0].replace('"operations_new"','operations');sql.exec(opDDL);
 sql.exec(`CREATE TABLE line_items(id TEXT PRIMARY KEY,operation_id TEXT REFERENCES operations(id) ON DELETE CASCADE,product_id TEXT REFERENCES products(id),item_description TEXT,qty INTEGER,unit_price INTEGER,unit_price_after_disc INTEGER,line_amount INTEGER,currency TEXT,created_at INTEGER,updated_at INTEGER);
 CREATE TABLE operation_attachments(id TEXT PRIMARY KEY,operation_id TEXT REFERENCES operations(id) ON DELETE CASCADE,direction TEXT,kind TEXT,doc_number TEXT,doc_date INTEGER,amount INTEGER,currency TEXT,issuer TEXT,file_url TEXT,parsed_from TEXT,source_ref_id TEXT,notes TEXT,created_at INTEGER,updated_at INTEGER);
 CREATE TABLE document_extractions(id TEXT PRIMARY KEY,status TEXT,target_table TEXT,target_id TEXT,reviewed_by TEXT,reviewed_at INTEGER,updated_at INTEGER,raw_extract_json TEXT,deleted_at INTEGER);
 INSERT INTO operations(id,operation_date,operation_type,our_company_id,vat_rate,created_at,updated_at) VALUES('old',1,'sale','dasean',20,1,1);
 INSERT INTO line_items(id,operation_id,product_id,line_amount) VALUES('oldline','old','de203',123);
 CREATE TRIGGER preserve_operations_trigger AFTER UPDATE OF operation_type ON operations BEGIN UPDATE operations SET notes='preserved' WHERE id=NEW.id; END;`);
 sql.exec(migration('0095_vn_einvoice.sql'));sql.exec(migration('0142_vn_einvoice_manual.sql'));sql.exec(migration('0143_vn_operation_link.sql'));
 const order={source_order_id:'530124445322445',channel:'lazada',source_evidence_ref:'attended verified order',captured_at:'2026-10-26T08:00:00Z',currency:'VND',buyer:{kind:'business',name:'Jomu',tax_code:'3600661374',address:'VN address'},payment_method:'Mixedcard',items:[{sku:'DE203',name:'GINGER',unit:'Tube',quantity:1,gross_amount:99000,vat_rate:8,vat_evidence_ref:'confirmed'},{sku:'DE210',name:'INNOWEISS',unit:'Tube',quantity:1,gross_amount:199000,vat_rate:8,vat_evidence_ref:'confirmed'}],shipping_gross:32800,shipping_discount:32800,total_gross:298000};
 const inv={Ikey:'swh-530124445322445',Pattern:'1C26MAA',Serial:'',InvoiceStatus:1,No:'1',ArisingDate:'26/10/2026',CustomerName:'Jomu',CustomerAddress:'VN address',CustomerTaxCode:'3600661374',Total:275926,TaxAmount:22074,Amount:298000,TCTCheckStatus:'Hợp lệ',TaxAuthorityCode:'CODE'};
 sql.prepare(`INSERT INTO vn_einvoice_documents(id,source,source_event_id,source_order_id,action,ikey,pattern,serial,state,request_r2_key,response_r2_key,created_at,updated_at,workflow,normalized_order_json,provider_pdf_r2_key,provider_xml_r2_key) VALUES('doc','manual_lazada','event',?,'issue',?,'1C26MAA','','issued','request','receipt',1,1,'manual',?,'final.pdf','final.xml')`).run(order.source_order_id,inv.Ikey,JSON.stringify(order));
 sql.prepare("INSERT INTO document_extractions(id,status,raw_extract_json) VALUES('dex','pending_review',?)").run(JSON.stringify({provider_draft:{Ikey:inv.Ikey}}));
 const DB={prepare(q){let args=[];return {bind(...values){args=values;return this;},async first(){return sql.prepare(q).get(...args)??null;},async all(){return {results:sql.prepare(q).all(...args)};},async run(){return {meta:{changes:Number(sql.prepare(q).run(...args).changes)}};}};},async batch(stmts){sql.exec('BEGIN');try{const out=[];for(const stmt of stmts)out.push(await stmt.run());sql.exec('COMMIT');return out;}catch(e){sql.exec('ROLLBACK');throw e;}}};
 const env={DB,DOCS:{async get(){return {text:async()=>JSON.stringify({body:{Status:2,Data:{Invoices:[inv]}}})};}}};
 const row=()=>sql.prepare("SELECT * FROM vn_einvoice_documents WHERE id='doc'").get();
 return {sql,env,row,inv};
}
test('VAT migration preserves old rates, inbound FK rows and triggers; accepts8 and rejects unsupported rates',()=>{
 const {sql}=fixture();assert.equal(sql.prepare("SELECT vat_rate FROM operations WHERE id='old'").get().vat_rate,20);assert.equal(sql.prepare("SELECT line_amount FROM line_items WHERE id='oldline'").get().line_amount,123);assert.equal(sql.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name='preserve_operations_trigger'").get().n,1);assert.deepEqual(sql.prepare('PRAGMA foreign_key_check').all(),[]);assert.throws(()=>sql.exec("UPDATE operations SET vat_rate=7 WHERE id='old'"));
});
test('accepted existing invoice links one normal sale with exact VND amounts and no fabricated contract/payment/delivery',async()=>{
 const {env,row,sql}=fixture();const id=await linkManualOperation(env,row(),'usr_aram');assert.equal(await linkManualOperation(env,row(),'usr_aram'),id);
 const op=sql.prepare('SELECT * FROM operations WHERE id=?').get(id);assert.equal(op.total_amount,298000);assert.equal(op.vat_rate,8);assert.equal(op.currency,'VND');assert.equal(op.our_company_id,'dasean');assert.equal(op.contract_id,null);assert.equal(op.status,'issued');assert.equal(op.delivery_status,'pending');
 assert.deepEqual(sql.prepare('SELECT qty,line_amount FROM line_items WHERE operation_id=? ORDER BY line_amount').all(id).map(x=>({...x})),[{qty:1,line_amount:91667},{qty:1,line_amount:184259}]);assert.equal(sql.prepare('SELECT count(*) n FROM partners').get().n,1);assert.equal(sql.prepare('SELECT count(*) n FROM operation_attachments').get().n,2);
 assert.equal(sql.prepare("SELECT target_id FROM document_extractions WHERE id='dex'").get().target_id,id);
});
test('draft order is a regular draft operation without attachments and can later adopt same issued invoice',async()=>{
 const f=fixture();f.inv.InvoiceStatus=0;f.inv.No='0';const id=await linkManualOperation(f.env,f.row(),'actor');assert.equal(f.sql.prepare('SELECT status FROM operations WHERE id=?').get(id).status,'draft');assert.equal(f.sql.prepare('SELECT count(*) n FROM operation_attachments').get().n,0);
 f.inv.InvoiceStatus=1;f.inv.No='1';await syncManualOperation(f.env,f.row());assert.equal(f.sql.prepare('SELECT status FROM operations WHERE id=?').get(id).status,'issued');assert.equal(f.sql.prepare('SELECT count(*) n FROM operation_attachments').get().n,2);
});
test('mismatched provider identity or missing product cannot partially create a buyer or operation',async()=>{
 for (const mutate of [f=>{f.inv.Pattern='wrong';},f=>{f.sql.exec("DELETE FROM products WHERE id='de210'");}]){const f=fixture();mutate(f);await assert.rejects(linkManualOperation(f.env,f.row(),'actor'));assert.equal(f.sql.prepare('SELECT count(*) n FROM operations').get().n,1);assert.equal(f.sql.prepare('SELECT count(*) n FROM partners').get().n,0);}
});
test('existing changed total is held; refresh never creates a second invoice attachment or marks delivery',async()=>{
 const f=fixture(),id=await linkManualOperation(f.env,f.row(),'actor');await syncManualOperation(f.env,f.row());assert.equal(f.sql.prepare('SELECT count(*) n FROM operation_attachments').get().n,2);f.sql.prepare('UPDATE operations SET total_amount=1 WHERE id=?').run(id);await assert.rejects(linkManualOperation(f.env,f.row(),'actor'),/operation_link_conflict/);
});
