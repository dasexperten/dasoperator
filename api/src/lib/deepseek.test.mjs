import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const { build } = createRequire(new URL('../../../workers/package.json', import.meta.url))('esbuild');
const dir = mkdtempSync(join(tmpdir(), 'deepseek-json-'));
const outfile = join(dir, 'client.mjs');
await build({ entryPoints: [fileURLToPath(new URL('./deepseek.ts', import.meta.url))], bundle: true,
  platform: 'node', format: 'esm', outfile });
const { callPro } = await import(pathToFileURL(outfile));
rmSync(dir, { recursive: true });
test('JSON readers request provider JSON mode; prose requests keep their existing contract', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return Response.json({ choices: [{ message: { content: '{"ok":true}' } }], usage: {} });
  });
  await callPro([{ role: 'user', content: 'JSON fixture' }], { apiKey: 'fixture-only', jsonMode: true });
  await callPro([{ role: 'user', content: 'prose fixture' }], { apiKey: 'fixture-only' });
  assert.deepEqual(requests[0].response_format, { type: 'json_object' });
  assert.equal('response_format' in requests[1], false);
});
