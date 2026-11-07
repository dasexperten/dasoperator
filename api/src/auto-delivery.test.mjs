import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(new URL('../../workers/package.json', import.meta.url));
const { build } = require('esbuild');
const dir = mkdtempSync(join(tmpdir(), 'auto-delivery-'));
const outfile = join(dir, 'sweep.mjs');
await build({ entryPoints: [fileURLToPath(new URL('./auto-delivery.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'esm', outfile });
const { runAutoDeliverySweep } = await import(pathToFileURL(outfile));
rmSync(dir, { recursive: true });

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE warehouses(id TEXT PRIMARY KEY, code TEXT, warehouse_type TEXT);
    CREATE TABLE operations(id TEXT PRIMARY KEY, warehouse_to_id TEXT, operation_type TEXT,
      status TEXT, deleted_at INTEGER, updated_at INTEGER, arrival_detected_at INTEGER,
      arrival_source_request_id TEXT, arrival_received_qtys TEXT);
    CREATE TABLE stock_movements(source_ref_id TEXT, movement_type TEXT);
    CREATE TABLE line_items(operation_id TEXT, product_id TEXT, qty INTEGER);
    CREATE TABLE marketplace_stocks_wb(base_sku TEXT, quantity INTEGER, pack_factor INTEGER);
    CREATE TABLE marketplace_stocks_ozon(base_sku TEXT, fbo_available INTEGER, pack_factor INTEGER);
    CREATE TABLE external_requests(id TEXT, warehouse_id TEXT, is_completed INTEGER,
      imported_op_id TEXT, created_at_external TEXT);
    INSERT INTO warehouses VALUES ('lbr','LBR','external'), ('ozon','OZON','external');
    INSERT INTO marketplace_stocks_wb VALUES ('sku',100000,1);
    INSERT INTO marketplace_stocks_ozon VALUES ('sku',100000,1);
  `);
  const now = Math.floor(Date.now() / 1000);
  const add = (id, { warehouse = 'lbr', status = 'shipped', type = 'purchase',
    updated = now, deleted = null, transit = true, receipt = null, qtys = null } = {}) => {
    db.prepare('INSERT INTO operations VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, warehouse, type, status, deleted, updated, receipt ? now : null, receipt, qtys);
    db.prepare('INSERT INTO line_items VALUES(?,?,?)').run(id, 'sku', 10);
    if (transit) db.prepare('INSERT INTO stock_movements VALUES(?,?)').run(id, 'in_transit_in');
  };
  const patches = [];
  const env = {
    DB: { prepare(sql) {
      const statement = db.prepare(sql);
      let values = [];
      return { bind(...args) { values = args; return this; },
        async all() { return { results: statement.all(...values) }; },
        async first() { return statement.get(...values) ?? null; } };
    } },
    SELF: { async fetch(request) { patches.push(request); return Response.json({ success: true }); } },
  };
  return { db, env, add, patches, now };
}

test('existing stock at either marketplace never confirms a purchase or transfer receipt', async () => {
  const f = fixture();
  try {
    f.add('purchase');
    f.add('transfer', { warehouse: 'ozon', type: 'transfer' });
    const result = await runAutoDeliverySweep(f.env);
    assert.equal(result.scanned, 2);
    assert.equal(result.awaiting_confirmation, 2);
    assert.equal(result.evidence_policy, 'shipment_receipt_required_manual_confirmation_only');
    assert.deepEqual(result.delivered, []);
    assert.equal(f.patches.length, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM operations WHERE status='shipped'").get().n, 2);
  } finally { f.db.close(); }
});

test('heuristic arrival metadata, partial/other/stale receipts and already-posted acceptance cannot close a shipment', async () => {
  const f = fixture();
  try {
    const proofs = [
      ['heuristic', 'lbr', 1, null, new Date().toISOString(), '{"sku":10}'],
      ['partial', 'lbr', 1, null, new Date().toISOString(), '{"sku":3}'],
      ['other-warehouse', 'ozon', 1, null, new Date().toISOString(), '{"sku":10}'],
      ['stale', 'lbr', 1, null, '2020-01-01', '{"sku":10}'],
      ['posted', 'lbr', 1, 'separate-posted-operation', new Date().toISOString(), '{"sku":10}'],
    ];
    for (const [id, warehouse, completed, imported, at, qtys] of proofs) {
      f.add(id, { receipt: id, qtys });
      f.db.prepare('INSERT INTO external_requests VALUES(?,?,?,?,?)').run(id, warehouse, completed, imported, at);
    }
    const before = f.db.prepare('SELECT * FROM operations ORDER BY id').all();
    const result = await runAutoDeliverySweep(f.env);
    assert.equal(result.awaiting_confirmation, proofs.length);
    assert.deepEqual(result.skipped.map(row => row.reason), proofs.map(() => 'shipment_receipt_not_confirmed'));
    assert.deepEqual(result.delivered, []);
    assert.equal(f.patches.length, 0);
    assert.deepEqual(f.db.prepare('SELECT * FROM operations ORDER BY id').all(), before);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM stock_movements').get().n, proofs.length);
  } finally { f.db.close(); }
});

test('sweep reports only current shipped goods already in transit; completed and ineligible operations stay untouched', async () => {
  const f = fixture();
  try {
    f.add('eligible');
    f.add('delivered', { status: 'delivered' });
    f.add('deleted', { deleted: f.now });
    f.add('old', { updated: f.now - 91 * 86400 });
    f.add('not-in-transit', { transit: false });
    f.add('sale', { type: 'sale' });
    const result = await runAutoDeliverySweep(f.env);
    assert.equal(result.scanned, 1);
    assert.deepEqual(result.skipped, [{ id: 'eligible', reason: 'shipment_receipt_not_confirmed' }]);
    assert.equal(f.patches.length, 0);
  } finally { f.db.close(); }
});
