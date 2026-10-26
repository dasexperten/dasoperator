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
const { parseInventoryJson, readInventoryLetter } = await import(pathToFileURL(outfile));
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
