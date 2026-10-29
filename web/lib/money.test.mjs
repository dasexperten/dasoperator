import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(new URL('../../workers/package.json', import.meta.url));
const { transform, build } = require('esbuild');
const compiled = await transform(readFileSync(new URL('./money.ts', import.meta.url), 'utf8'), {
  loader: 'ts', format: 'esm',
});
const { formatMinor, toMinor, fromMinor } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`
);

test('VietinBank payment and fee values stay in whole VND in assignment summaries', () => {
  assert.equal(formatMinor(2862000, 'VND'), '2,862,000 VND');
  assert.equal(formatMinor(24750000, 'VND'), '24,750,000 VND');
  assert.equal(formatMinor(22000, 'VND'), '22,000 VND');
  assert.equal(formatMinor(27656000, 'VND'), '27,656,000 VND');
  assert.equal(toMinor(2862000, 'VND'), 2862000);
  assert.equal(fromMinor(2862000, 'VND'), 2862000);
});

test('RUB and USD retain their cents and zero-fraction currencies remain whole', () => {
  assert.equal(formatMinor(34147600, 'RUB'), '341,476.00 RUB');
  assert.equal(formatMinor(488930, 'USD'), '4,889.30 USD');
  for (const currency of ['VND', 'JPY', 'KRW']) {
    assert.equal(formatMinor(1234, currency), `1,234 ${currency}`);
  }
});

test('the real assignment component renders the same VND scale as the finance list', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vnd-assignment-'));
  const outfile = join(dir, 'render.mjs');
  try {
    // Next preserves JSX for its compiler; this standalone Node render must lower it.
    const tsconfig = join(dir, 'tsconfig.json');
    writeFileSync(tsconfig, JSON.stringify({ compilerOptions: { jsx: 'react-jsx',
      baseUrl: fileURLToPath(new URL('..', import.meta.url)), paths: { '@/*': ['./*'] } } }));
    await build({
      stdin: {
        contents: `import React from 'react';
          import { renderToStaticMarkup } from 'react-dom/server';
          import AssignWizard from '../components/banking/AssignWizard';
          export const render = item => renderToStaticMarkup(React.createElement(AssignWizard, { item, onResolved() {} }));`,
        resolveDir: fileURLToPath(new URL('.', import.meta.url)),
      },
      bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', outfile,
      tsconfig,
      banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(new URL('../../workers/package.json', import.meta.url).href)});` },
    });
    const { render } = await import(pathToFileURL(outfile));
    const item = { id: 'fixture', direction: 'outgoing', executed_at: 1793059200,
      contragent_name: 'Tica', contragent_inn: '', currency: 'VND' };
    for (const amount of [2862000, 24750000, 22000]) {
      assert.ok(render({ ...item, amount }).includes(`-${formatMinor(amount, 'VND')}`));
    }
    assert.ok(render({ ...item, amount: 34147600, currency: 'RUB' }).includes('-341,476.00 RUB'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
