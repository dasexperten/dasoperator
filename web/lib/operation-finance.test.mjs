import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const require = createRequire(new URL('../../workers/package.json', import.meta.url));
const { build } = require('esbuild');
const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL('./operation-finance.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', write: false });
const { operationTotals, operationSettlement } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);
const service = { operation_type: 'service', operation_track: 'service', total_amount: 9017501, currency: 'VND', vat_rate: 8 };

test('AT ASIA gross already includes VAT: whole VND and outgoing advance fully settles it', () => {
  const t = operationTotals(service, []);
  assert.equal(t.totalAfterDiscount, 8349538);
  assert.equal(t.vatAmount, 667963);
  assert.equal(t.grandTotal, 9017501);
  assert.equal(t.subtotal, 8349538);
  assert.equal(t.showVat, true);
  assert.deepEqual(operationSettlement(service, [{ amount: 9017501, direction: 'outgoing', type: 'advance' }], t.grandTotal, 'supplier'), { paidAmount: 9017501, outstanding: 0 });
});
test('FedEx and Treasury retain full tax amounts and do not assert a zero import VAT rate', () => {
  for (const amount of [4510397, 17249087]) {
    const tax = { ...service, operation_type: 'tax', total_amount: amount, vat_rate: 0 };
    const t = operationTotals(tax, []);
    assert.equal(t.vatAmount, 0);
    assert.equal(t.grandTotal, amount);
    assert.equal(t.subtotal, amount);
    assert.equal(t.showVatSummary, false);
    assert.equal(t.vatSummaryLabel, 'Additional VAT');
    assert.deepEqual(operationSettlement(tax, [{ amount, direction: 'outgoing' }], amount, 'other'), { paidAmount: amount, outstanding: 0 });
  }
});
test('header-only service currency rounding preserves gross and does not add VAT again', () => {
  const t = operationTotals({ ...service, total_amount: 108.01, currency: 'USD' }, []);
  assert.equal(t.totalAfterDiscount, 100.01);
  assert.equal(t.vatAmount, 8);
  assert.equal(t.grandTotal, 108.01);
});
test('goods discount, VAT, zero-rate goods and managed Vietnam per-line rounding stay unchanged', () => {
  const goods = { ...service, operation_type: 'sale', operation_track: 'goods', total_amount: 777, vat_rate: 20 };
  const lines = [{ qty: 2, unit_price: 100, line_amount: 180 }];
  const t = operationTotals(goods, lines);
  assert.equal(t.subtotal, 200); assert.equal(t.discount, 20); assert.equal(t.discountPct, 10);
  assert.equal(t.totalAfterDiscount, 180); assert.equal(t.vatAmount, 36); assert.equal(t.grandTotal, 216);
  assert.equal(operationTotals({ ...goods, vat_rate: 0 }, lines).grandTotal, 180);
  const fiscal = operationTotals({ ...goods, total_amount: 195, vat_rate: 8, vn_einvoice_document_id: 'verified-fiscal' }, lines);
  assert.equal(fiscal.vatAmount, 15); assert.equal(fiscal.grandTotal, 195);
});
test('refunds reverse settlement on both sides; buyer services and unknown sides preserve receivable convention', () => {
  const outgoing = [{ amount: 100, direction: 'outgoing' }, { amount: 20, direction: 'incoming' }];
  assert.deepEqual(operationSettlement({ operation_type: 'purchase' }, outgoing, 100), { paidAmount: 80, outstanding: 20 });
  assert.deepEqual(operationSettlement(service, outgoing, 100, 'supplier'), { paidAmount: 80, outstanding: 20 });
  const incoming = [{ amount: 100, direction: 'incoming' }, { amount: 20, direction: 'outgoing' }];
  for (const [type, partner] of [['sale', 'buyer'], ['service', 'buyer'], ['service', undefined], ['transfer', undefined]]) {
    assert.deepEqual(operationSettlement({ operation_type: type }, incoming, 100, partner), { paidAmount: 80, outstanding: 20 });
  }
  assert.deepEqual(operationSettlement(service, [{ amount: 110, direction: 'outgoing' }], 100, 'supplier'), { paidAmount: 110, outstanding: -10 });
});


test('both real detail routes render VAT and settlement with the loaded supplier role', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'operation-finance-render-'));
  try {
    const tsconfig = join(temp, 'tsconfig.json');
    writeFileSync(tsconfig, JSON.stringify({ compilerOptions: { jsx: 'react-jsx', baseUrl: fileURLToPath(new URL('..', import.meta.url)), paths: { '@/*': ['./*'] } } }));
    for (const [name, relative] of [
      ['operations', '../app/operations/[id]/operation-detail-client.tsx'],
      ['partner', '../app/partners/[slug]/operations/[id]/operation-detail-client.tsx'],
    ]) {
      const route = fileURLToPath(new URL(relative, import.meta.url));
      const outfile = join(temp, name+'.mjs');
      await build({
        stdin: { contents: `import React from 'react'; import { renderToStaticMarkup } from 'react-dom/server';
          import Detail from ${JSON.stringify(route)};
          export function render(fixture) { globalThis.__financeFixture = fixture;
            return renderToStaticMarkup(React.createElement(Detail, { operationId: fixture.operation.id, partnerSlug: fixture.partner.id })); }`,
          resolveDir: fileURLToPath(new URL('.', import.meta.url)) },
        bundle: true, platform: 'node', format: 'esm', outfile, tsconfig,
        banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(new URL('../../workers/package.json', import.meta.url).href)});` },
        plugins: [{ name: 'loaded-api-state', setup(b) {
          // Seed only the asynchronous API-loading state. The actual route,
          // totals calls, partner-role wiring, tables and summary JSX are intact.
          b.onLoad({ filter: /operation-detail-client\.tsx$/ }, args => {
            if (args.path !== route) return;
            let source = readFileSync(args.path, 'utf8');
            for (const [state, value] of [['partner','partner'],['operation','operation'],['lineItems','lines'],['payments','payments'],['activeTab','tab'],['loading','loaded']]) {
              const pattern = new RegExp('(const \\[' + state + ',[^\\n]+?useState(?:<[^\\n]*?>)?\\()([^\\n]*)(\\);)');
              assert.ok(pattern.test(source), `${name}: API state ${state} found`);
              source = source.replace(pattern, `$1globalThis.__financeFixture.${value}$3`);
            }
            return { contents: source, loader: 'tsx', resolveDir: fileURLToPath(new URL('..', pathToFileURL(route))) };
          });
          b.onResolve({ filter: /^(?:@\/components\/|next\/link$)/ }, args => ({ path: args.path, namespace: 'unrelated-chrome' }));
          b.onLoad({ filter: /.*/, namespace: 'unrelated-chrome' }, () => ({ contents: 'export default function Chrome(){return null;}', loader: 'js' }));
        } }],
      });
      const { render } = await import(pathToFileURL(outfile));
      const fixture = { partner: { id: 'at-asia-hcm', trade_name: 'AT ASIA HCM', partner_type: 'supplier', kind: 'service_provider' },
        operation: { ...service, id: 'op_vn_atasia_00014531', partner_id: 'at-asia-hcm', status: 'issued', reference: 'ATASIA-00014531', our_company_id: 'dasean', operation_date: 1790596800 },
        lines: [], payments: [{ id: 'pay_at_1031926P26031973', amount: 9017501, currency: 'VND', direction: 'outgoing', type: 'advance', payment_date: 1790424000 }], loaded: false };
      const plain = html => html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
      const items = plain(render({ ...fixture, tab: 'items' }));
      assert.match(items, /Net 8,349,538/); assert.match(items, /VAT 8% \+667,963/); assert.match(items, /Total 9,017,501/);
      const paid = plain(render({ ...fixture, tab: 'payments' }));
      assert.match(paid, /Paid 9,017,501 Outstanding 0/);
      for (const amount of [4510397,17249087]) {
        const taxFixture = { ...fixture, partner: { ...fixture.partner, partner_type: 'other' }, operation: { ...fixture.operation, operation_type: 'tax', vat_rate: 0, total_amount: amount }, payments: [{ ...fixture.payments[0], amount }], tab: 'payments' };
        const tax = plain(render(taxFixture));
        assert.ok(!tax.includes('VAT None')); assert.ok(!tax.includes('Additional VAT'));
        assert.ok(tax.includes(`Paid ${amount.toLocaleString('en-US')} Outstanding 0`));
      }
    }
  } finally { delete globalThis.__financeFixture; rmSync(temp, { recursive: true, force: true }); }
});
