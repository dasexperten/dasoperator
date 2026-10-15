import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { managementDb, OP, LINES, runReceipt, snapshot, validateSnapshot, verifySource } from './swifthub-air.mjs';

// Real SQLite executes the unchanged production primitive, including UPSERT,
// unique stock states, positive receipts, and journal insertion.
function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE warehouses(id TEXT PRIMARY KEY,code,country,owner_company_id,deleted_at);
    CREATE TABLE companies(id TEXT PRIMARY KEY,legal_name,jurisdiction,deleted_at);
    CREATE TABLE operations(id TEXT PRIMARY KEY,reference,operation_type,operation_track,our_company_id,
      warehouse_from_id,warehouse_to_id,status,delivery_status,deleted_at,notes);
    CREATE TABLE line_items(id TEXT PRIMARY KEY,operation_id,product_id,qty,cartons,inner_boxes);
    CREATE TABLE products(id TEXT PRIMARY KEY,deleted_at);
    CREATE TABLE inventory_sessions(id TEXT PRIMARY KEY,warehouse_id,status,committed_at);
    CREATE TABLE stocks(id TEXT PRIMARY KEY,warehouse_id,product_id,stock_state CHECK(stock_state IN
      ('on_hand','in_production','in_transit')),on_hand INTEGER,last_movement_at,last_counted_at,last_counted_by,
      updated_at,UNIQUE(warehouse_id,product_id,stock_state));
    CREATE TABLE stock_movements(id TEXT PRIMARY KEY,warehouse_id,product_id,movement_type,
      quantity INTEGER,source,source_ref_type,source_ref_id,reason,notes,performed_by,performed_at,
      balance_after,stock_state,created_at);
    INSERT INTO warehouses VALUES('swh','SWH','Vietnam','dasean',NULL);
    INSERT INTO companies VALUES('dasean','Das Experten ASEAN Co. Ltd.','Vietnam',NULL);
  `);
  sqlite.prepare('INSERT INTO operations VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
    OP, 'WDAA-26091601', 'purchase', 'goods', 'dasean', 'gzh', null, 'issued', 'delivered', null, 'Preserve all existing notes');
  for (const [sku, id] of LINES) {
    sqlite.prepare('INSERT INTO products VALUES(?,NULL)').run(sku);
    sqlite.prepare('INSERT INTO line_items VALUES(?,?,?,?,?,?)').run(id, OP, sku, 144, 2, 12);
  }
  let failJournal = false;
  const db = { prepare(sql) { return { bind(...params) {
    const execute = (method) => {
      if (failJournal && /INSERT INTO stock_movements/.test(sql)) throw new Error('simulated journal failure');
      return sqlite.prepare(sql)[method](...params);
    };
    return { first: async () => execute('get') ?? null,
      all: async () => ({ results: execute('all'), success: true }),
      run: async () => execute('run') };
  } }; } };
  return { sqlite, db, failJournal: () => { failJournal = true; } };
}

test('default dry-run verifies live shape and performs no writes', async () => {
  await verifySource();
  const f = fixture();
  const result = await runReceipt(f.db);
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.pending_inputs.length, 4);
  assert.ok(result.pending_inputs.every((input) => !Object.hasOwn(input, 'performed_at')));
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM stocks').get().n, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM stock_movements').get().n, 0);
});

test('four real receipts, current timestamps, then repeat verifies without duplication', async () => {
  const f = fixture();
  const operationBefore = JSON.stringify(f.sqlite.prepare('SELECT * FROM operations').all());
  const started = Math.floor(Date.now() / 1000);
  const result = await runReceipt(f.db, { apply: true });
  assert.equal(result.writes, 4);
  assert.deepEqual(result.balances.map((row) => row.on_hand), [144, 144, 144, 144]);
  assert.equal(new Set(result.movements.map((row) => row.id)).size, 4);
  assert.ok(result.movements.every((row) => row.performed_at >= started && row.performed_at <= Math.floor(Date.now() / 1000)));
  assert.equal(JSON.stringify(f.sqlite.prepare('SELECT * FROM operations').all()), operationBefore);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM stocks WHERE warehouse_id IN ('otw','gzh')").get().n, 0);
  const resumed = await runReceipt(f.db, { apply: true });
  assert.equal(resumed.writes, 0);
  assert.equal(resumed.movements.length, 4);
});

test('a stock-only partial write is reported and cannot be blindly retried', async () => {
  const f = fixture();
  f.failJournal();
  const events = [];
  await assert.rejects(runReceipt(f.db, { apply: true, emit: (e) => events.push(e) }), /ambiguous write/);
  assert.equal(events.at(-1).stage, 'ambiguous-write-stopped');
  assert.equal(events.at(-1).balances[0].on_hand, 144);
  assert.equal(events.at(-1).movements.length, 0);
  await assert.rejects(runReceipt(f.db, { apply: true }), /Stock-only partial write/);
  assert.equal(f.sqlite.prepare('SELECT SUM(on_hand) AS n FROM stocks').get().n, 144);
});

test('count cutoff, wrong company, quantity mismatch and unexplained receipt each stop before mutation', async () => {
  for (const sql of [
    "INSERT INTO inventory_sessions VALUES('count','swh','committed',100)",
    "UPDATE warehouses SET owner_company_id='another-company'",
    "UPDATE line_items SET qty=143 WHERE product_id='de203'",
    "INSERT INTO stock_movements(id,warehouse_id,product_id,movement_type,quantity) VALUES('prior','swh','de202','receipt',144)",
  ]) {
    const f = fixture();
    f.sqlite.exec(sql);
    await assert.rejects(runReceipt(f.db, { apply: true }));
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM stocks').get().n, 0);
  }
});

test('fresh per-line check catches an intervening writer and stops the next receipt', async () => {
  const f = fixture();
  let inserted = false;
  await assert.rejects(runReceipt(f.db, { apply: true, emit(event) {
    if (event.stage === 'receipt-verified' && !inserted) {
      inserted = true;
      f.sqlite.exec("INSERT INTO stocks VALUES('foreign','swh','de203','on_hand',1,0,NULL,NULL,0)");
    }
  } }), /Stock-only partial write/);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM stock_movements').get().n, 1);
  assert.equal(f.sqlite.prepare("SELECT on_hand FROM stocks WHERE product_id='de203'").get().on_hand, 1);
});

test('duplicate journal evidence is rejected even if stock still says 144', async () => {
  const f = fixture();
  await runReceipt(f.db, { apply: true });
  f.sqlite.exec(`INSERT INTO stock_movements SELECT 'duplicate',warehouse_id,product_id,movement_type,quantity,
    source,source_ref_type,source_ref_id,reason,notes,performed_by,performed_at,balance_after,stock_state,created_at
    FROM stock_movements WHERE product_id='de202'`);
  const state = await snapshot(f.db);
  assert.throws(() => validateSnapshot(state), /Duplicate receipt/);
});

test('management adapter never retries or exposes provider bodies/credential values', async () => {
  let calls = 0;
  const db = managementDb({ CLOUDFLARE_API_TOKEN: 'test-secret-not-a-real-key',
    CLOUDFLARE_ACCOUNT_ID: '081ddb85cb399ad62a70210328d744fc',
    CLOUDFLARE_DATABASE_ID: '0653d156-5069-4c46-a496-fad982d0d1df' }, async () => {
    calls++;
    return { ok: false, status: 503, json() { throw new Error('provider-secret'); } };
  });
  await assert.rejects(db.prepare('SELECT 1').bind().first(), (error) => {
    assert.match(error.message, /HTTP 503/);
    assert.doesNotMatch(error.message, /test-secret|provider-secret/);
    return true;
  });
  assert.equal(calls, 1);
});
