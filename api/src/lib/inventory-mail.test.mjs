import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(new URL('../../../workers/package.json', import.meta.url));
const { build } = require('esbuild');
const dir = mkdtempSync(join(tmpdir(), 'inventory-json-'));
const outfile = join(dir, 'reader.mjs');
await build({ entryPoints: [fileURLToPath(new URL('./inventory-mail.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'esm', outfile,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  plugins: [{ name: 'no-effects', setup(b) {
    b.onResolve({ filter: /^(\.\/deepseek|\.\/anthropic|\.\/diana-subscription\.mjs|\.\/inbox-archive|\.\/owner-telegram|\.\.\/routes\/inventory-sessions)$/ }, a => ({ path: a.path, namespace: 'mock' }));
    b.onLoad({ filter: /.*/, namespace: 'mock' }, (a) => ({ contents: `
      export const callPro=(messages,opts)=>globalThis.__inventoryRead('${a.path.includes('anthropic') ? 'sonnet' : 'deepseek'}',messages,opts);
      export const subscriptionInfer=()=> (messages,opts)=>globalThis.__inventoryRead('terra',messages,opts);
      export const archiveEmail=()=>{throw Error('unexpected archive')};
      export const sendOwnerTelegram=(...args)=>globalThis.__inventoryMessage(...args);
      export default {request(){throw Error('unexpected stock write')}};
    ` }));
  } }] });
const { parseInventoryJson, readInventoryLetter, readStockSheet, normalizeSku, compareWithBook, processInventoryLetter } = await import(pathToFileURL(outfile));
const workerFile = join(dir, 'mail-worker.mjs');
await build({ entryPoints: [fileURLToPath(new URL('../../../workers/erp-inventory/src/index.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'esm', outfile: workerFile,
  plugins: [{ name: 'mail-boundary', setup(b) {
    b.onResolve({ filter: /_shared\/run$/ }, () => ({ path: 'run', namespace: 'mail-mock' }));
    b.onResolve({ filter: /lib\/inventory-mail$/ }, () => ({ path: 'bytes', namespace: 'mail-mock' }));
    b.onLoad({ filter: /.*/, namespace: 'mail-mock' }, a => ({ contents: a.path === 'run'
      ? `export const runLogged=(env,_worker,_cron,job)=>job(env,false);`
      : `export const bytesToB64=raw=>Buffer.from(raw).toString('base64');` }));
  } }] });
const { default: mailWorker } = await import(pathToFileURL(workerFile));
rmSync(dir, { recursive: true });
const valid = { warehouse_id: 'fixture-warehouse', warehouse_certain: true,
  rows: [{ source: 'fixture 0', product_id: 'fixture', qty_pieces: 0 }] };
test('typed JSON preserves a counted zero and rejects unsafe commit inputs', () => {
  assert.deepEqual(parseInventoryJson(JSON.stringify(valid)), valid);
  assert.throws(() => parseInventoryJson(JSON.stringify({ ...valid, warehouse_certain: 'false' })));
  for (const quantity of [-1, 1.5, '0', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseInventoryJson(JSON.stringify({ ...valid,
      rows: [{ ...valid.rows[0], qty_pieces: quantity }] })));
  }
  assert.throws(() => parseInventoryJson('{"rows":[}'));
});
function readerEnv() {
  return { DB: { prepare(sql) { return { async all() { return { results: sql.includes('FROM products')
    ? [{ id: 'fixture', pieces_per_case: 1 }] : [{ id: 'fixture-warehouse' }] }; } }; } } };
}
const letter = { text: 'fixture 0', from: 'fixture', subject: 'fixture', messageId: 'fixture-message' };
test('Terra succeeds first; fallback models are not called', async () => {
  const calls=[];
  globalThis.__inventoryRead=async(provider,_messages,opts)=>{calls.push(provider);assert.equal(opts.model,'gpt-6.1-terra');return {text:JSON.stringify(valid)};};
  const result=await readInventoryLetter(readerEnv(),letter);
  assert.deepEqual(result.out,valid);assert.equal(result.model,'gpt-6.1-terra');assert.deepEqual(calls,['terra']);
});
test('Terra quota/outage or empty answer falls back to Sonnet', async () => {
  for(const first of [Error('quota exhausted'),Error('offline'),'   ']) {
    const calls=[];
    globalThis.__inventoryRead=async(provider)=>{calls.push(provider);if(provider==='terra'){if(first instanceof Error)throw first;return {text:first};}return {text:JSON.stringify(valid)};};
    const result=await readInventoryLetter(readerEnv(),letter);assert.equal(result.model,'claude-sonnet-4-6');assert.deepEqual(calls,['terra','sonnet']);
  }
});
test('DeepSeek is the last fallback after Terra and Sonnet are unavailable or empty', async () => {
  const calls=[];let original;
  globalThis.__inventoryRead=async(provider,messages,opts)=>{calls.push(provider);original??=messages;assert.deepEqual(messages,original);if(provider==='terra')throw Error('quota');if(provider==='sonnet')return {text:''};assert.equal(opts.jsonMode,true);return {text:JSON.stringify(valid)};};
  assert.equal((await readInventoryLetter(readerEnv(),letter)).model,'deepseek-v4-pro');assert.deepEqual(calls,['terra','sonnet','deepseek']);
});
test('unusable readings advance the bounded fallback chain', async () => {
  for(const text of ['{broken',JSON.stringify({...valid,warehouse_id:'invented'}),JSON.stringify({...valid,rows:[{source:'unreadable',product_id:null,qty_pieces:null}]})]) {
    const calls=[];globalThis.__inventoryRead=async(provider)=>{calls.push(provider);return {text:provider==='terra'?text:JSON.stringify(valid)};};
    assert.equal((await readInventoryLetter(readerEnv(),letter)).model,'claude-sonnet-4-6');assert.deepEqual(calls,['terra','sonnet']);
  }
});
test('three unavailable providers stop with no fourth call', async () => {
  const calls=[];globalThis.__inventoryRead=async(provider)=>{calls.push(provider);throw Error('offline');};
  await assert.rejects(readInventoryLetter(readerEnv(),letter),/no stock written/);assert.deepEqual(calls,['terra','sonnet','deepseek']);
});

function journalEnv() {
  const claims=new Set(),writes=[],messages=[];
  globalThis.__inventoryMessage=async(_env,text)=>messages.push(text);
  return {writes,messages,env:{...readerEnv(),DB:{prepare(sql){let args;return {
    bind(...a){args=a;return this;},
    async run(){assert.match(sql,/^INSERT (OR IGNORE|OR REPLACE) INTO inventory_mail_log/);writes.push({sql,args});
      if(sql.includes('OR IGNORE')){const id=args[3];if(claims.has(id))return {meta:{changes:0}};claims.add(id);}return {meta:{changes:1}};},
    async all(){if(sql.includes('FROM stocks'))return {results:[{product_id:'fixture',on_hand:2}]};return {results:sql.includes('FROM products')?[{id:'fixture'}]:[{id:'fixture-warehouse',name:'Fixture warehouse'}]};}
  };}}}};
}
test('failure is recorded once and redelivery cannot restart the three-model chain', async () => {
  const calls=[];globalThis.__inventoryRead=async(provider)=>{calls.push(provider);throw Error('offline')};
  const {env,writes,messages}=journalEnv();assert.equal((await processInventoryLetter(env,letter)).status,'failed');
  assert.equal((await processInventoryLetter(env,letter)).status,'duplicate');assert.deepEqual(calls,['terra','sonnet','deepseek']);
  assert.equal(messages.length,1);assert.equal(writes.filter(w=>w.sql.includes('OR REPLACE'))[0].args[7],'failed');
});
test('concurrent delivery claims before recognition; comparison never writes stock', async () => {
  const calls=[];globalThis.__inventoryRead=async(provider)=>{calls.push(provider);return {text:JSON.stringify(valid)}};
  const {env,messages}=journalEnv();const results=await Promise.all([processInventoryLetter(env,letter),processInventoryLetter(env,letter)]);
  assert.deepEqual(results.map(r=>r.status).sort(),['compared','duplicate']);assert.deepEqual(calls,['terra']);assert.equal(messages.length,1);
});

const sheet = [[], [], ['', '', '', 'шт', '', 'шт'],
  ['', 'DE120', 'NANO 1шт', 96, 14, 110], ['', 'DE120A4', 'NANO 4шт', 72, 25, 97], ['', 'DE119 AA', 'GROSSE', 5, '', 5],
  ['', 'DE107A4', 'MITTEL', 2, '', 2], ['', 'DE107AAAA', 'MITTEL', 3, '', 3], ['', '', 'Поднос', 10, '', 10]];
test('Mery sheet is read by the total column, with her spellings normalized', () => {
  const rows = readStockSheet(sheet);
  assert.deepEqual(rows.map((r) => [r.product_id, r.qty_pieces]),
    [['de120', 110], ['de120aaaa', 97], ['de119aa', 5], ['de107aaaa', 2], ['de107aaaa', 3], [null, 10]]);
  assert.equal(normalizeSku('DE117 A4'), 'de117aaaa');
});
test('an unknown sheet shape goes to the model', () => {
  assert.equal(readStockSheet([['товар', 'кол-во'], ['нить', 3]]), null);
});
test('a product missing from the letter is a gap, a counted match is not', () => {
  const gaps = compareWithBook(new Map([['a', 5], ['b', 3]]),
    [{ product_id: 'a', on_hand: 5 }, { product_id: 'b', on_hand: 10 }, { product_id: 'c', on_hand: 100 }]);
  assert.deepEqual(gaps, [{ product_id: 'c', counted: 0, book: 100, gap: -100 }, { product_id: 'b', counted: 3, book: 10, gap: -7 }]);
});

test('Mery XLSX always goes through a model, even when the deterministic parser knows its shape', async () => {
  const XLSX=createRequire(new URL('../../../api/package.json',import.meta.url))('xlsx');
  const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(sheet),'Stock');
  const base64=XLSX.write(wb,{type:'base64',bookType:'xlsx'});const calls=[];
  globalThis.__inventoryRead=async(provider,messages)=>{calls.push(provider);assert.match(messages[1].content,/DE120/);return {text:JSON.stringify(valid)}};
  await readInventoryLetter(readerEnv(),{...letter,attachments:[{filename:'stock.xlsx',base64}]});assert.deepEqual(calls,['terra']);
});

test('mail worker delegates original bytes once; it never starts recognition or resubmits a failed chain', async () => {
  const calls=[];let copies=0;
  const raw='From: fixture@example.test\r\nMessage-ID: <fixture-boundary>\r\nSubject: Stock\r\n\r\nfixture 0';
  const env={ERP_RUN_SECRET:'fixture-only',ERP:{async fetch(url,init){calls.push({url,input:JSON.parse(init.body)});return Response.json({ok:false,note:'all recognition providers failed'});}}};
  await assert.rejects(mailWorker.email({raw:new Blob([raw]).stream(),from:'fixture@example.test',async forward(){copies++;}},env),/all recognition providers failed/);
  assert.equal(copies,1);assert.equal(calls.length,1);assert.equal(Buffer.from(calls[0].input.raw_b64,'base64').toString(),raw);
  assert.deepEqual(Object.keys(calls[0].input).sort(),['envelope_from','raw_b64']);
});
