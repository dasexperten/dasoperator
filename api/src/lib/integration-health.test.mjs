// node --test api/src/lib/integration-health.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const esbuildPath = createRequire(import.meta.url).resolve('esbuild', { paths: [root, join(root, 'workers')] });
const { transformSync } = await import(pathToFileURL(esbuildPath).href);
const ts = readFileSync(new URL('./integration-health.ts', import.meta.url), 'utf8');
const dir = mkdtempSync(join(tmpdir(), 'integration-health-'));
writeFileSync(join(dir, 'h.mjs'), transformSync(ts, { loader: 'ts', format: 'esm' }).code);
const { classifyAge, MP_RULES } = await import(join(dir, 'h.mjs'));

test('daily marketplace jobs remain healthy before their next scheduled window', () => {
  const stocks = MP_RULES.find((r) => r.key === 'ozon_stocks');
  assert.equal(stocks.expects, 'daily 00:30 Yerevan');
  assert.equal(classifyAge(17, stocks.degraded_after_h, stocks.broken_after_h), 'healthy');
  assert.equal(classifyAge(26, stocks.degraded_after_h, stocks.broken_after_h), 'degraded');
  assert.equal(classifyAge(28, stocks.degraded_after_h, stocks.broken_after_h), 'broken');
});

test('daily sales rules use the same schedule-aware SLA', () => {
  for (const key of ['ozon_sales', 'wb_sales']) {
    const rule = MP_RULES.find((r) => r.key === key);
    assert.equal(rule.expects, 'daily 01:00 Yerevan');
    assert.equal(rule.degraded_after_h, 25);
    assert.equal(rule.broken_after_h, 27);
  }
});
