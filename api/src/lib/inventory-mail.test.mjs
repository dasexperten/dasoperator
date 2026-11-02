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
    b.onResolve({ filter: /^(\.\/deepseek|\.\/inbox-archive|\.\/owner-telegram|\.\.\/routes\/inventory-sessions)$/ }, a => ({ path: a.path, namespace: 'mock' }));
    b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: `
      export const callPro=(messages,opts)=>globalThis.__inventoryRead(messages,opts);
      export const archiveEmail=()=>{throw Error('unexpected archive')};
      export const sendOwnerTelegram=()=>{throw Error('unexpected message')};
      export default {request(){throw Error('unexpected stock write')}};
    ` }));
  } }] });
const { parseInventoryJson, readInventoryLetter, readStockSheet, normalizeSku, compareWithBook } = await import(pathToFileURL(outfile));
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
test('malformed model output retries once in JSON mode before any mutation', async () => {
  let calls = 0;
  globalThis.__inventoryRead = async (_messages, opts) => {
    assert.equal(opts.jsonMode, true);
    calls++;
    return { text: calls === 1 ? '{"rows":[}' : JSON.stringify(valid) };
  };
  const env = { DB: { prepare() { return { async all() { return { results: [] }; } }; } } };
  const result = await readInventoryLetter(env, { text: 'fixture 0', from: 'fixture', subject: 'fixture' });
  assert.deepEqual(result.out, valid);
  assert.equal(calls, 2);
});
test('repeated malformed output fails closed after exactly two calls', async () => {
  let calls = 0;
  globalThis.__inventoryRead = async () => { calls++; return { text: '{broken' }; };
  const env = { DB: { prepare() { return { async all() { return { results: [] }; } }; } } };
  await assert.rejects(readInventoryLetter(env, { text: 'fixture', from: 'fixture', subject: 'fixture' }), /no stock written/);
  assert.equal(calls, 2);
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
