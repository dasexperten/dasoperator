// Standalone, local-only D1 integration coverage. Run from the repository root:
//   node --test api/src/lib/ugc-payout-intake.d1.test.mjs
// Uses the installed API toolchain (Miniflare/esbuild), never wrangler.toml,
// .dev.vars, account credentials, remote D1, or the full application's bindings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { build } = require('esbuild');
const { Miniflare } = require('miniflare');
const now = Date.parse('2026-11-09T12:00:00Z');

// Apply the actual schema migrations needed by this boundary, including their
// CHECK, UNIQUE, NOT NULL and foreign-key constraints. Do not apply unrelated
// production data repairs, seeds, or the application's full migration chain.
const schemaMigrations = [
  '0060_crm_website.sql',
  '0098_ugc_creator_pipeline.sql',
  '0116_ugc_payouts.sql',
  '0119_ugc_payouts_konsol.sql',
  '0120_ugc_ig_messages.sql',
  '0128_ugc_payout_product.sql',
];

// This adapter only records results returned by the real Worker D1 binding.
// It does not implement SQL, synthesize metadata, or replace D1 transactions.
const workerSource = `
  import { prepareCreatorPayout } from './ugc-payout-intake.ts';
  export default {
    async fetch(request, env) {
      const batches = [];
      try {
        const body = await request.json();
        if (body.action === 'batch') {
          const results = await env.DB.batch(body.statements.map(({sql, params = []}) => {
            const statement = env.DB.prepare(sql);
            return params.length ? statement.bind(...params) : statement;
          }));
          return Response.json({results});
        }
        if (body.action !== 'intake') return new Response('Unknown test action', {status: 400});
        const DB = {
          prepare(sql) { return env.DB.prepare(sql); },
          async batch(statements) {
            const results = await env.DB.batch(statements);
            batches.push(results);
            return results;
          },
        };
        const result = await prepareCreatorPayout({DB}, body.input, body.now);
        return Response.json({result, batches});
      } catch (error) {
        return Response.json({error: error.message, batches}, {status: 500});
      }
    },
  };
`;

async function bounded(promise, label, timeoutMs = 20_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const facts = {
  verified: true,
  handle: 'synthetic_alice',
  conversation_id: 'synthetic_chat',
  cycle_message_id: 'synthetic_amount',
  source_message_ids: ['synthetic_amount', 'synthetic_bank'],
  amount_minor: 45300,
  phone: '+79990000000',
  first_name: 'SyntheticAlice',
  fps_bank_member_id: '100000000004',
  bank_ref: 'Synthetic bank',
  cart_review: { source_message_id: 'synthetic_image', amount_minor: 45300 },
};
const pendingSql = "SELECT key,value,updated_at FROM crm_sync_state WHERE key LIKE 'diana_payout_intake_pending:%'";

test('isolated Worker D1: UGC payout intake safety', { timeout: 120_000 }, async (t) => {
  const bundle = await build({
    stdin: {
      contents: workerSource,
      resolveDir: fileURLToPath(new URL('.', import.meta.url)),
      sourcefile: 'ugc-payout-intake-d1-fixture.ts',
      loader: 'ts',
    },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
  });
  const outboundRequests = [];
  const mf = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: '2024-12-01',
    host: '127.0.0.1',
    port: 0,
    d1Databases: { DB: 'synthetic-ugc-payout-intake-test-only' },
    d1Persist: false,
    cachePersist: false,
    outboundService(request) {
      outboundRequests.push(request.url);
      throw new Error('External network access is forbidden in the intake D1 test');
    },
  });
  t.after(async () => {
    try {
      await bounded(mf.dispose(), 'Miniflare cleanup', 5_000);
    } finally {
      assert.deepEqual(outboundRequests, [], 'intake must not call any external service');
    }
  });
  await bounded(mf.ready, 'Isolated Miniflare/workerd startup');

  async function request(body) {
    const response = await bounded(mf.dispatchFetch('http://localhost/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }), 'Local Worker request');
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.error || `Local Worker returned ${response.status}`);
      error.batches = data.batches;
      throw error;
    }
    return data;
  }
  const batch = async (statements) => (await request({action: 'batch', statements})).results;
  const query = async (sql, ...params) => (await batch([{sql, params}]))[0].results;
  const intake = (patch = {}, at = now) => request({action: 'intake', input: {...facts, ...patch}, now: at});
  const pending = async () => (await query(pendingSql))[0];

  for (const name of schemaMigrations) {
    const source = await readFile(new URL(`../../../db/migrations/${name}`, import.meta.url), 'utf8');
    // These six migrations contain only simple DDL, no trigger bodies or
    // semicolons in string literals. Fail closed if that ever changes.
    const sql = source.replace(/--[^\n]*/g, '');
    assert.doesNotMatch(sql, /\b(?:TRIGGER|INSERT|UPDATE|DELETE)\b/i, `${name} must remain schema-only`);
    for (const literal of sql.match(/'(?:[^']|'')*'/g) ?? []) {
      assert.ok(!literal.includes(';'), `${name} needs a SQL-aware statement splitter`);
    }
    const statements = sql.split(';').map(sql => sql.trim()).filter(Boolean).map(sql => ({sql}));
    const results = await batch(statements);
    assert.equal(results.length, statements.length);
    assert.ok(results.every(row => row.success === true), `migration ${name}`);
  }

  async function reset() {
    await batch([
      {sql: 'DROP TRIGGER IF EXISTS synthetic_fail_requisites'},
      {sql: 'DROP TRIGGER IF EXISTS synthetic_fail_receipt'},
      ...['ugc_payout_requisites', 'ugc_payouts', 'ugc_creator_platforms', 'ugc_creators',
        'crm_sync_state', 'ugc_ig_messages'].map(table => ({sql: `DELETE FROM ${table}`})),
      {
        sql: `INSERT INTO ugc_ig_messages(id,conversation_id,direction,from_username,created_at,seen_at,attachments_json)
          VALUES(?1,?4,'in',?5,?6,?6,NULL), (?2,?4,'in',?5,?7,?7,NULL), (?3,?4,'in',?5,?8,?8,'[{}]')`,
        params: ['synthetic_amount', 'synthetic_bank', 'synthetic_image', facts.conversation_id, facts.handle,
          '2026-11-08T10:00:00Z', '2026-11-08T11:00:00Z', '2026-11-09T11:00:00Z'],
      },
    ]);
  }
  async function assertNoFinancialRows() {
    for (const table of ['ugc_payouts', 'ugc_payout_requisites', 'ugc_creator_platforms', 'ugc_creators']) {
      assert.equal((await query(`SELECT count(*) AS n FROM ${table}`))[0].n, 0, table);
    }
    assert.deepEqual(await query("SELECT key FROM crm_sync_state WHERE key LIKE 'diana_payout_intake:%' OR key LIKE 'diana_payout_intake_lock:%'"), []);
  }
  function pendingBatch(call, changes) {
    assert.equal(call.batches.length, 3, 'lock, pending transaction, unlock');
    const result = call.batches[1];
    assert.equal(result.length, 2);
    assert.ok(result.every(row => row.success === true));
    assert.equal(result[0].meta.changes, changes, 'actual D1 upsert metadata');
    assert.equal(result[1].results.length, 1, 'actual D1 SELECT in the same batch');
    return result[1].results[0].value;
  }

  await t.test('unknown or parser-only amount creates pending metadata, never a one-kopeck financial row', async () => {
    for (const observed of [1, 45300]) {
      await reset();
      const call = await intake({amount_minor: observed, cart_review: undefined});
      assert.deepEqual(call.result, {
        outcome: 'clarification_required', registered: false,
        missing_fields: ['amount_minor'], dispatch_status: 'not_dispatched',
      });
      const readback = pendingBatch(call, 1);
      const row = await pending();
      assert.equal(row.value, readback);
      assert.deepEqual(JSON.parse(row.value), {
        version: 1, status: 'needs_clarification', dispatch_status: 'not_dispatched',
        conversation_id: facts.conversation_id, cycle_message_id: facts.cycle_message_id,
        source_message_ids: facts.source_message_ids, source_at: Date.parse('2026-11-08T11:00:00Z'),
        missing_fields: ['amount_minor'], observed_amount_minor: null,
      });
      for (const privateValue of [facts.phone, facts.first_name, facts.bank_ref]) {
        assert.ok(!row.value.includes(privateValue), 'pending metadata contains no raw requisites');
      }
      await assertNoFinancialRows();
    }
  });

  await t.test('repeat is a D1 zero-change upsert with identical durable readback', async () => {
    await reset();
    await intake({cart_review: undefined});
    const before = await pending();
    const replay = await intake({cart_review: undefined}, now + 1000);
    assert.equal(pendingBatch(replay, 0), before.value);
    assert.deepEqual(await pending(), before, 'dedup must preserve updated_at too');
    assert.equal((await query(pendingSql)).length, 1);
    await assertNoFinancialRows();
  });

  await t.test('reviewed 453 RUB follows existing approval flow and resolves pending JSON', async () => {
    await reset();
    await intake({cart_review: undefined});
    const saved = (await intake({}, now + 1)).result;
    const replay = (await intake({}, now + 2)).result;
    assert.equal(saved.amount_minor, 45300);
    assert.equal(saved.status, 'awaiting_approval');
    assert.equal(replay.id, saved.id);
    assert.ok(!('fps_mobile_phone' in saved), 'raw phone is not returned');
    assert.equal((await query('SELECT count(*) AS n FROM ugc_payouts'))[0].n, 1);
    const payout = (await query('SELECT * FROM ugc_payouts'))[0];
    assert.equal(payout.konsol_payment_id, null);
    assert.equal(payout.execute_claim, null);
    assert.equal((await query('SELECT lifecycle_stage FROM ugc_creators'))[0].lifecycle_stage, 'cart');
    assert.deepEqual((await query('SELECT fps_mobile_phone,first_name,last_name,patronymic FROM ugc_payout_requisites'))[0], {
      fps_mobile_phone: facts.phone, first_name: facts.first_name, last_name: null, patronymic: null,
    });
    const proof = JSON.parse((await query("SELECT value FROM crm_sync_state WHERE key LIKE 'diana_payout_intake:%'"))[0].value);
    assert.equal(proof.verified, true);
    assert.equal(proof.payout_id, saved.id);
    assert.equal(JSON.parse((await pending()).value).status, 'resolved');
    assert.equal(JSON.parse((await pending()).value).dispatch_status, 'not_dispatched');
  });

  await t.test('a valid Owner amount survives newer requisites without fresh cart review', async () => {
    await reset();
    const original = (await intake()).result;
    await query('UPDATE ugc_payouts SET amount_minor=48700 WHERE id=?1', original.id);
    const result = (await intake({
      cart_review: undefined,
      amount_minor: 1,
      source_message_ids: ['synthetic_amount', 'synthetic_image'],
      bank_ref: 'Synthetic replacement bank',
      fps_bank_member_id: '100000000273',
    }, now + 1)).result;
    assert.equal(result.id, original.id);
    assert.equal(result.amount_minor, 48700);
    assert.equal(result.bank_ref, 'Synthetic replacement bank');
    assert.equal((await query('SELECT amount_minor FROM ugc_payouts'))[0].amount_minor, 48700);
  });

  await t.test('reviewed 394 RUB without a name stays pending and never becomes financial', async () => {
    await reset();
    const call = await intake({first_name: null, cart_review: {source_message_id: 'synthetic_image', amount_minor: 39400}});
    assert.equal(call.result.registered, false);
    assert.deepEqual(call.result.missing_fields, ['first_name']);
    const record = JSON.parse(pendingBatch(call, 1));
    assert.equal(record.observed_amount_minor, 39400);
    assert.equal(record.status, 'needs_clarification');
    await assertNoFinancialRows();
  });

  await t.test('real D1 batch failure rolls back payout, requisites, stage and receipt', async () => {
    for (const [trigger, table, condition] of [
      ['synthetic_fail_requisites', 'ugc_payout_requisites', ''],
      ['synthetic_fail_receipt', 'crm_sync_state', "WHEN NEW.key LIKE 'diana_payout_intake:%'"],
    ]) {
      await reset();
      await query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON ${table} ${condition}
        BEGIN SELECT RAISE(ABORT, 'synthetic storage failure'); END`);
      await assert.rejects(intake(), /synthetic storage failure/);
      await assertNoFinancialRows();
      assert.deepEqual(await query('SELECT * FROM crm_sync_state'), []);
    }
  });

  await t.test('claimed or uncertain pending dispatch is never reset by a repeated intake', async () => {
    for (const state of ['claimed', 'uncertain']) {
      await reset();
      await intake({cart_review: undefined});
      await query("UPDATE crm_sync_state SET value=json_set(value,'$.dispatch_status',?1) WHERE key LIKE 'diana_payout_intake_pending:%'", state);
      const before = await pending();
      await assert.rejects(intake({cart_review: undefined}, now + 1), error => {
        assert.match(error.message, /payout_intake_clarification_not_verified/);
        assert.equal(pendingBatch(error, 0), before.value);
        return true;
      });
      assert.deepEqual(await pending(), before);
      await assertNoFinancialRows();
    }
  });

  await t.test('newer incomplete originals reopen resolved undispatched metadata without changing payout', async () => {
    await reset();
    await intake({cart_review: undefined});
    await intake({}, now + 1);
    const before = await query('SELECT * FROM ugc_payouts');
    const call = await intake({first_name: null, source_message_ids: ['synthetic_amount', 'synthetic_image']}, now + 2);
    const record = JSON.parse(pendingBatch(call, 1));
    assert.equal(record.status, 'needs_clarification');
    assert.equal(record.source_at, Date.parse('2026-11-09T11:00:00Z'));
    assert.deepEqual(record.missing_fields, ['first_name']);
    assert.deepEqual(await query('SELECT * FROM ugc_payouts'), before);
  });
});
