import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { patchPayout as patch } from './ugc-payout-patch.mjs';

const statuses = ['awaiting_approval', 'approved', 'sent', 'paid', 'failed'];
const locks = ['', "execute_claim='claimed'", "konsol_payment_id='provider'", "konsol_status='paid_outside'"];
const financial = { amount_minor: 50000, payout_date: '2026-11-10', phone_masked: '+78XX*****89', bank_ref: 'new bank' };
function fixture(status = 'awaiting_approval', lock = '') {
  const sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON; CREATE TABLE crm_sync_state(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL)');
  for (const name of ['0098_ugc_creator_pipeline.sql', '0116_ugc_payouts.sql', '0119_ugc_payouts_konsol.sql', '0120_ugc_ig_messages.sql'])
    sql.exec(readFileSync(new URL('../../../db/migrations/' + name, import.meta.url), 'utf8'));
  sql.exec("INSERT INTO ugc_creators(id,normalized_handle,created_at,updated_at) VALUES('c','demo',0,0)");
  const insert = sql.prepare(`INSERT INTO ugc_payouts(id,creator_id,status,amount_minor,payout_date,marketplace,phone_masked,bank_ref,note,created_at,updated_at)
    VALUES(?,'c',?,47400,'2026-11-09','WB','+79XX*****67','previous bank','previous note',0,0)`);
  insert.run('p', status);
  // Existing payout history must never stop editing the selected payout.
  insert.run('old-paid', 'paid');
  sql.exec("INSERT INTO ugc_payout_requisites(payout_id,fps_mobile_phone,first_name,created_at,updated_at) VALUES('p','+79991234567','Анна',0,0)");
  if (lock) sql.exec(`UPDATE ugc_payouts SET ${lock} WHERE id='p'`);
  const db = {
    beforeBatch: null, failAt: null, calls: 0, queries: [],
    prepare(q) { return { bind(...args) { return { q, args }; } }; },
    async batch(statements) {
      db.calls++;
      db.beforeBatch?.();
      sql.exec('BEGIN');
      try {
        const results = statements.map(({ q, args }, index) => {
          db.queries.push(q);
          if (index === db.failAt) throw new Error('injected statement failure');
          const s = sql.prepare(q);
          const bind = Object.fromEntries(args.map((value, i) => [String(i + 1), value]));
          return q.startsWith('SELECT') ? { success: true, results: s.all(bind) }
            : { success: true, meta: { changes: Number(s.run(bind).changes) } };
        });
        sql.exec('COMMIT');
        return results;
      } catch (e) { sql.exec('ROLLBACK'); throw e; }
    },
  };
  const input = { id: 'p', patch: { ...financial, marketplace: 'Ozon', note: 'new note' }, now: 100 };
  const payout = () => sql.prepare("SELECT * FROM ugc_payouts WHERE id='p'").get();
  const snapshot = () => JSON.stringify({ p: sql.prepare('SELECT * FROM ugc_payouts ORDER BY id').all(), r: sql.prepare('SELECT * FROM ugc_payout_requisites').all() });
  return { sql, db, input, payout, snapshot };
}
const allowed = (status, lock) => !['sent', 'paid'].includes(status) && !lock;

test('real schema has foreign keys enabled and rejects orphan requisites', () => {
  const { sql } = fixture();
  assert.equal(sql.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.throws(() => sql.exec("INSERT INTO ugc_payout_requisites(payout_id,fps_mobile_phone,created_at,updated_at) VALUES('none','+79991234567',0,0)"), /FOREIGN KEY/);
});

test('every status/lock permits or rejects all protected fields atomically', async () => {
  for (const status of statuses) for (const lock of locks) {
    const { db, input, snapshot, payout } = fixture(status, lock);
    const before = snapshot();
    const result = await patch(db, input);
    if (!allowed(status, lock)) {
      assert.deepEqual(result, { ok: false, http: 409, code: 'payout_not_editable' });
      assert.equal(snapshot(), before, status + '/' + lock);
    } else {
      assert.equal(result.ok, true);
      assert.equal(result.changes, 1);
      for (const [key, value] of Object.entries(input.patch)) assert.equal(result.payout[key], value);
      assert.equal(payout().status, status);
      assert.equal(payout().creator_id, 'c');
      assert.equal(payout().execute_claim, null);
      assert.equal(payout().konsol_payment_id, null);
    }
  }
});

test('each protected field is independently guarded and mixed note fails wholly', async () => {
  for (const [key, value] of Object.entries(financial)) {
    for (const set of ["status='sent'", "status='paid'", ...locks.slice(1)]) {
      const { sql, db, input, snapshot } = fixture();
      sql.exec(`UPDATE ugc_payouts SET ${set} WHERE id='p'`);
      input.patch = { [key]: value, note: 'must not partially save' };
      const before = snapshot();
      assert.equal((await patch(db, input)).http, 409, key + '/' + set);
      assert.equal(snapshot(), before);
    }
  }
});

test('note and marketplace remain safe to edit on every protected or unprotected row', async () => {
  for (const status of statuses) for (const lock of locks) {
    const { db, input, payout, sql } = fixture(status, lock);
    const before = { ...payout() };
    const requisites = sql.prepare('SELECT * FROM ugc_payout_requisites').get();
    input.patch = { note: 'administrative correction', marketplace: null };
    const result = await patch(db, input);
    assert.equal(result.ok, true, status + '/' + lock);
    assert.deepEqual({ ...payout() }, { ...before, ...input.patch, updated_at: input.now });
    assert.deepEqual(sql.prepare('SELECT * FROM ugc_payout_requisites').get(), requisites);
  }
});

test('post-precheck claim/provider/status/paid_outside wins over financial PATCH', async () => {
  for (const set of ["execute_claim='race'", "konsol_payment_id='race'", "status='sent'", "status='paid'", "konsol_status='paid_outside'"]) {
    const { sql, db, input, payout, snapshot } = fixture('approved');
    assert.equal(payout().execute_claim, null); // The route precheck has passed.
    let concurrent;
    db.beforeBatch = () => { sql.exec(`UPDATE ugc_payouts SET ${set} WHERE id='p'`); concurrent = snapshot(); };
    assert.equal((await patch(db, input)).http, 409);
    assert.equal(snapshot(), concurrent);
  }
});

test('note-only PATCH never writes omitted financial fields from a stale snapshot', async () => {
  const { sql, db, input, payout } = fixture('approved');
  const stale = payout();
  let concurrent;
  db.beforeBatch = () => {
    sql.exec("UPDATE ugc_payouts SET amount_minor=60000,payout_date='2026-11-11',phone_masked='+77XX*****88',bank_ref='concurrent bank',marketplace='concurrent shop',execute_claim='race',updated_at=90 WHERE id='p'");
    concurrent = { ...payout() };
  };
  input.patch = { note: 'note after precheck' };
  const result = await patch(db, input);
  assert.equal(result.ok, true);
  assert.notEqual(result.payout.amount_minor, stale.amount_minor);
  assert.deepEqual({ ...payout() }, { ...concurrent, note: input.patch.note, updated_at: input.now });
  assert.equal(result.payout.amount_minor, 60000);
  assert.equal(result.payout.payout_date, '2026-11-11');
  assert.equal(result.payout.phone_masked, '+77XX*****88');
  assert.equal(result.payout.bank_ref, 'concurrent bank');
  assert.equal(result.payout.marketplace, 'concurrent shop');
  assert.match(db.queries[0], /^UPDATE ugc_payouts SET note=\?2,updated_at=\?3 WHERE id=\?1$/);
});

test('an explicitly supplied financial field does not overwrite any omitted fields', async () => {
  const { sql, db, input, payout } = fixture();
  db.beforeBatch = () => sql.exec("UPDATE ugc_payouts SET payout_date='2026-11-20',bank_ref='concurrent' WHERE id='p'");
  input.patch = { amount_minor: 55000 };
  assert.equal((await patch(db, input)).ok, true);
  assert.equal(payout().amount_minor, 55000);
  assert.equal(payout().payout_date, '2026-11-20');
  assert.equal(payout().bank_ref, 'concurrent');
});

test('repeated no-op fields succeed unclaimed, but protected intent is rejected after claim', async () => {
  for (const status of ['awaiting_approval', 'approved', 'failed']) {
    const { sql, db, input, payout, snapshot } = fixture(status);
    input.patch = { amount_minor: payout().amount_minor, note: payout().note };
    assert.equal((await patch(db, input)).changes, 1);
    assert.equal((await patch(db, input)).changes, 1);
    sql.exec("UPDATE ugc_payouts SET execute_claim='claim' WHERE id='p'");
    const before = snapshot();
    assert.equal((await patch(db, input)).http, 409);
    assert.equal(snapshot(), before);
    input.patch = { note: payout().note };
    assert.equal((await patch(db, input)).changes, 1);
    assert.equal((await patch(db, input)).changes, 1);
  }
});

test('empty strings for claim and provider are unclaimed; paid_outside alone protects', async () => {
  const { sql, db, input } = fixture();
  sql.exec("UPDATE ugc_payouts SET execute_claim='',konsol_payment_id='',konsol_status='failed' WHERE id='p'");
  assert.equal((await patch(db, input)).ok, true);
  sql.exec("UPDATE ugc_payouts SET konsol_status='paid_outside' WHERE id='p'");
  assert.equal((await patch(db, input)).http, 409);
});

test('write and readback statement exceptions atomically roll back all mutations', async () => {
  for (const failAt of [0, 1]) {
    const { db, input, snapshot } = fixture();
    const before = snapshot();
    db.failAt = failAt;
    assert.deepEqual(await patch(db, input), { ok: false, http: 503, code: 'payout_write_unavailable' });
    assert.equal(snapshot(), before);
  }
});

test('database constraint and update-trigger errors do not report success or partially save', async () => {
  for (const mode of ['constraint', 'trigger']) {
    const { sql, db, input, snapshot } = fixture();
    if (mode === 'constraint') input.patch.amount_minor = 100000; // The copied 0116 constraint, not a new helper policy.
    else sql.exec("CREATE TRIGGER broken BEFORE UPDATE ON ugc_payouts BEGIN SELECT RAISE(ABORT,'failure'); END;");
    const before = snapshot();
    assert.equal((await patch(db, input)).http, 503);
    assert.equal(snapshot(), before);
  }
});

test('missing target and deletion after precheck return 404 without creating data', async () => {
  for (const race of [false, true]) {
    const { sql, db, input, snapshot } = fixture();
    if (!race) input.id = 'missing';
    else db.beforeBatch = () => sql.exec("DELETE FROM ugc_payout_requisites WHERE payout_id='p'; DELETE FROM ugc_payouts WHERE id='p'");
    const before = snapshot();
    assert.deepEqual(await patch(db, input), { ok: false, http: 404, code: 'not_found' });
    if (!race) assert.equal(snapshot(), before);
    assert.equal(sql.prepare("SELECT count(*) n FROM ugc_payouts WHERE id='old-paid'").get().n, 1);
  }
});

test('zero affected safe-only update cannot be reported as a success', async () => {
  const { sql, db, input, snapshot } = fixture();
  input.patch = { note: 'blocked by trigger' };
  sql.exec("CREATE TRIGGER ignored BEFORE UPDATE ON ugc_payouts BEGIN SELECT RAISE(IGNORE); END;");
  const before = snapshot();
  assert.deepEqual(await patch(db, input), { ok: false, http: 503, code: 'payout_write_not_verified' });
  assert.equal(snapshot(), before);
});

test('missing, failed or inconsistent batch metadata/readback never reports success', async () => {
  for (const corrupt of [
    r => null,
    r => new Array(2),
    r => r.slice(0, 1),
    r => { r[0].success = false; return r; },
    r => { r[1].success = false; return r; },
    r => { delete r[0].meta; return r; },
    r => { r[0].meta.changes = 2; return r; },
    r => { r[0].meta.changes = '1'; return r; },
    r => { r[1].results = []; return r; },
    r => { r[1].results.push(r[1].results[0]); return r; },
    r => { r[1].results[0].id = 'wrong'; return r; },
    r => { r[1].results[0].amount_minor = 1; return r; },
    r => { r[1].results[0].updated_at = 999; return r; },
    r => { delete r[1].results[0].marketplace; return r; },
  ]) {
    const { db, input } = fixture();
    const batch = db.batch.bind(db);
    db.batch = async statements => corrupt(await batch(statements));
    assert.equal((await patch(db, input)).http, 503);
  }
});

test('invalid, unknown, lifecycle and SQL-shaped input fields are rejected before any SQL', async () => {
  const badPatches = [null, [], {}, { amount_minor: undefined }, { amount_minor: '100' }, { amount_minor: 0 },
    { amount_minor: NaN }, { amount_minor: 1.5 }, { amount_minor: Number.MAX_SAFE_INTEGER + 1 },
    { payout_date: null }, { payout_date: '2026-02-30' }, { payout_date: '2026-13-01' },
    { phone_masked: '+79991234567' }, { phone_masked: 123 }, { note: true }, { note: 'x'.repeat(1001) },
    { marketplace: 'x'.repeat(41) }, { bank_ref: {} }, { bank_ref: 'x'.repeat(201) },
    { status: 'paid' }, { execute_claim: null }, { creator_id: 'other' }, { updated_at: 999 },
    { fps_mobile_phone: '+79991234567' }, { fps_bank_member_id: '100000000111' }, { amount_rub: 10 },
    { 'note=?1 WHERE 1=1--': 'injection' }, { [Symbol('note')]: 'hidden' }];
  for (const value of badPatches) {
    const { db, input } = fixture();
    input.patch = value;
    assert.deepEqual(await patch(db, input), { ok: false, http: 422, code: 'invalid_payout_patch' });
    assert.equal(db.calls, 0);
    assert.equal(db.queries.length, 0);
  }
  for (const changes of [{ now: NaN }, { now: -1 }, { now: 0.5 }, { now: '100' }, { now: 8640000000000001 }, { id: '' }, { id: null }, { status: 'paid' }]) {
    const { db, input } = fixture();
    Object.assign(input, changes);
    assert.equal((await patch(db, input)).http, 422);
    assert.equal(db.calls, 0);
  }
});

test('nullable text fields can be explicitly cleared and leap dates remain valid', async () => {
  const { db, input, payout } = fixture();
  input.patch = { note: null, marketplace: null, phone_masked: null, bank_ref: null, payout_date: '2028-02-29' };
  assert.equal((await patch(db, input)).ok, true);
  for (const [key, value] of Object.entries(input.patch)) assert.equal(payout()[key], value);
});
