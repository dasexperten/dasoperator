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
const source = readFileSync(new URL('./easyinvoice.ts', import.meta.url), 'utf8');
const dir = mkdtempSync(join(tmpdir(), 'easyinvoice-'));
writeFileSync(join(dir, 'client.mjs'), transformSync(source, { loader: 'ts', format: 'esm' }).code);
const client = await import(join(dir, 'client.mjs'));

test('authentication matches the provider MD5/Base64 contract without logging credentials', () => {
  const header = client.buildAuthentication({
    method: 'POST',
    username: 'user',
    password: 'pass',
    taxCode: 'tax',
    timestamp: '1700000000',
    nonce: 'abc123',
  });
  assert.equal(header, 'lz8Y4kdkiS40eK/Tbd6cQw==:abc123:1700000000:user:pass:tax');
});

test('provider transport refuses HTTP and accepts the documented shared HTTPS host', () => {
  assert.throws(() => client.strictBaseUrl('http://api.softdreams.vn/'), /easyinvoice_https_required/);
  assert.equal(client.strictBaseUrl('https://api.easyinvoice.vn/'), 'https://api.easyinvoice.vn');
});

test('issue request requires the XML Ikey to equal the ERP idempotency key', () => {
  assert.deepEqual(client.submitBody({
    action: 'issue',
    ikey: 'swh-42',
    xmlData: '<Invoices><Inv><Invoice><Ikey>swh-42</Ikey></Invoice></Inv></Invoices>',
    pattern: '1C26TAA',
    serial: 'TEST',
  }), {
    XmlData: '<Invoices><Inv><Invoice><Ikey>swh-42</Ikey></Invoice></Inv></Invoices>',
    Pattern: '1C26TAA',
    Serial: 'TEST',
  });
  assert.throws(() => client.submitBody({
    action: 'issue',
    ikey: 'swh-42',
    xmlData: '<Invoices><Inv><Invoice><Ikey>different</Ikey></Invoice></Inv></Invoices>',
    pattern: '1C26TAA',
    serial: 'TEST',
  }), /xml_ikey_mismatch/);
});

test('Circular 78 accepts the documented empty Serial while legacy patterns do not', () => {
  assert.equal(client.isCircular78Pattern('1C26TAA'), true);
  assert.equal(client.isCircular78Pattern('01GTKT0/001'), false);
  assert.deepEqual(client.submitBody({
    action: 'issue',
    ikey: 'order-123',
    xmlData: '<Invoices><Inv><Invoice><Ikey>order-123</Ikey></Invoice></Inv></Invoices>',
    pattern: '1C26TAA',
    serial: '',
  }), {
    XmlData: '<Invoices><Inv><Invoice><Ikey>order-123</Ikey></Invoice></Inv></Invoices>',
    Pattern: '1C26TAA',
    Serial: '',
  });
  assert.throws(() => client.submitBody({
    action: 'issue',
    ikey: 'order-123',
    xmlData: '<Invoices><Inv><Invoice><Ikey>order-123</Ikey></Invoice></Inv></Invoices>',
    pattern: '01GTKT0/001',
    serial: '',
  }), /serial_required/);
});

test('uncertain duplicate responses are verified, while setup errors block', () => {
  assert.equal(client.needsVerification({ Status: 5, ErrorCode: 193 }), true);
  assert.equal(client.needsVerification({ Status: 4, ErrorCode: 169 }), true);
  assert.equal(client.isConfigurationBlock({ Status: 5, ErrorCode: 176 }), true);
  assert.equal(client.isMissingIkey({ Status: 4, ErrorCode: 128 }), true);
});

test('invoice number and lookup code are extracted for the matching Ikey', () => {
  assert.deepEqual(client.invoiceFacts({
    Status: 2,
    ErrorCode: 0,
    Data: {
      KeyInvoiceNo: { 'swh-42': '0000042' },
      Invoices: [{ Ikey: 'swh-42', No: '42', LookupCode: 'ABC' }],
    },
  }, 'swh-42'), { invoiceNo: '0000042', lookupCode: 'ABC' });
});
