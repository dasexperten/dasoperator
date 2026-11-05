/** Synthetic test harness only. No remote bindings or deploy configuration. */
import { createPilotStore } from '../store.mjs';
import { createOperationalCapture } from '../capture.mjs';
import { createMemoryHead } from '../memory-head.mjs';
import { createExportDestinationLedger } from '../export-destination-ledger.mjs';
import { createNightlyArchiveReceiptAdapter } from '../nightly-archive-receipt-adapter.mjs';

// Keep only plain state across requests. Every waiter creates and awaits its own
// timer in its current workerd request context; no request resolves another
// request's Promise or inherits a Promise created by a completed control request.
async function waitForState(predicate, timeout, error) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw Error(error);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

// Force both contenders to finish native reads and reach the native D1 INSERT
// before either commits. These counters coordinate the test, not a fake D1 engine.
const barriers = new Map();
async function beforeHeadInsert(id) {
  if (!id) return;
  let barrier = barriers.get(id);
  if (!barrier) {
    barrier = { arrived: 0, departed: 0, released: false };
    barriers.set(id, barrier);
  }
  barrier.arrived++;
  if (barrier.arrived === 2) barrier.released = true;
  try {
    await waitForState(() => barrier.released, 3000, 'synthetic_barrier_timeout');
  } finally {
    barrier.departed++;
    if (barrier.departed === barrier.arrived) barriers.delete(id);
  }
}

// Native D1 first() completes before the request pauses. The control requests
// only observe/set flags; polling Promises and timers never enter this map.
const stagedReads = new Map();
function readGate(id) {
  let gate = stagedReads.get(id);
  if (!gate) {
    gate = { reached: false, released: false, stage: null };
    stagedReads.set(id, gate);
  }
  return gate;
}
async function afterNativeRead(id, stage) {
  const gate = readGate(id);
  gate.reached = true;
  gate.stage = stage;
  try {
    await waitForState(() => gate.released, 5000, 'synthetic_read_barrier_timeout');
  } finally { stagedReads.delete(id); }
}

export default {
  async fetch(request, env) {
    const input = await request.json();
    const counts = { prepare: 0, get: 0, put: 0, authorize: 0, verify: 0, headAuthorize: 0, headWrites: 0 };
    let pausedRead = false;
    function statement(native, sql) {
      return {
        bind(...args) { return statement(native.bind(...args), sql); },
        async first(...args) {
          const result = await native.first(...args);
          const barrier = input.headReadBarrier;
          const matches = result === null && (
            barrier?.stage === 'after-prior-null' && sql.includes('SELECT * FROM pilot_working_memory_transitions') && sql.includes('request_id = ?')
            || barrier?.stage === 'after-current-null' && sql.includes('SELECT * FROM pilot_working_memory_heads')
          );
          if (!pausedRead && matches) { pausedRead = true; await afterNativeRead(barrier.id, barrier.stage); }
          return result;
        },
        all(...args) { return native.all(...args); },
        async run(...args) {
          const isReceipt = sql.includes('INSERT INTO pilot_export_destination_receipts');
          const isManifest = sql.includes('INSERT INTO pilot_operational_manifests');
          if (isReceipt && input.receiptFault === 'before-commit') throw Error('synthetic_receipt_before_commit');
          const isHead = sql.includes('INSERT INTO pilot_working_memory_transitions');
          if (isHead) { counts.headWrites++; await beforeHeadInsert(input.headBarrier); }
          const result = await native.run(...args);
          if ((isReceipt && input.receiptFault === 'after-commit') || (isManifest && input.manifestFault === 'after-commit')) throw Error('synthetic_response_lost_after_commit');
          if (isHead && input.headFault === 'after-commit') throw Error('synthetic_response_lost_after_commit');
          return result;
        },
      };
    }
    const db = { prepare(sql) { counts.prepare++; return statement(env.PILOT_DB.prepare(sql), sql); } };
    const bucket = {
      get(...args) { counts.get++; return env.PILOT_BUCKET.get(...args); },
      put(...args) { counts.put++; return env.PILOT_BUCKET.put(...args); },
    };
    const authorize = input.auth === 'missing' ? undefined : async ({ agent }) => {
      counts.authorize++;
      if (input.auth === 'throw') throw Error('synthetic_authorization_unavailable');
      if (input.auth === 'nonboolean') return { approved: true };
      return input.auth !== 'deny' && (input.authorizedAgents ?? ['angela', 'diana-helios']).includes(agent);
    };
    const store = createPilotStore({ config: input.config, db, bucket, authorize,
      now: () => new Date('2026-11-05T06:00:00Z') });
    const capture = createOperationalCapture({ config: input.config, store,
      sourceVerifier: async () => { counts.verify++; return input.verify !== false; } });
    try {
      const headAuthorize = input.headAuth === 'missing' ? undefined : async ({ agent, operation }) => {
        counts.headAuthorize++;
        if (input.headAuth === 'throw') throw Error('synthetic_head_authorization_unavailable');
        if (input.headAuth === 'nonboolean') return { approved: true };
        return input.headAuth !== 'deny' && (input.headAgents ?? ['angela', 'diana-helios']).includes(agent)
          && (!input.headOperations || input.headOperations.includes(operation));
      };
      const heads = createMemoryHead({ config: input.config, db, store, authorize: headAuthorize,
        now: () => new Date('2026-11-05T07:00:00Z') });
      const ledger = createExportDestinationLedger({ config: input.config, db, store,
        authorize: input.ledgerAuth === 'missing' ? undefined : async () => input.ledgerAuth !== 'deny',
        readCurrentSource: async ({ namespace, agent, table, sourceRowId }) => {
          const row = await db.prepare('SELECT body FROM synthetic_current_source WHERE namespace = ? AND agent = ? AND source_table = ? AND row_id = ?')
            .bind(namespace, agent, table, sourceRowId).first();
          return row ? new TextEncoder().encode(row.body) : null;
        }, now: () => new Date('2026-11-05T08:00:00Z') });
      const nightly = createNightlyArchiveReceiptAdapter({ config: input.config, capture, ledger,
        authorize: input.nightlyAuth === 'missing' ? undefined : async () => input.nightlyAuth !== 'deny',
        verifySnapshot: async ({ namespace, snapshotSha256 }) => {
          // A separate Node-side fixture registered this checkpoint before observe.
          // The observe request cannot supply the verifier's answer.
          const row = await db.prepare('SELECT checkpoint FROM synthetic_nightly_checkpoints WHERE namespace = ? AND hash = ?')
            .bind(namespace, snapshotSha256).first();
          return row ? JSON.parse(row.checkpoint) : null;
        } });
      let result;
      const bytes = input.bytes === undefined ? undefined : new Uint8Array(input.bytes);
      switch (input.operation) {
        case 'observeNightly': result = await nightly.observe(input.event); break;
        case 'recordReceipt': result = await ledger.recordReceipt(input.receiptRequest); break;
        case 'projectCurrent': result = await ledger.projectCurrent(input.sourceRequest); break;
        case 'import': result = await store.importSnapshot(input.descriptor, bytes); break;
        case 'read': {
          result = await store.readSnapshot(input.agent, input.id);
          if (result) result = { ...result, bytes: [...result.bytes] };
          break;
        }
        case 'captureD1Row': result = await capture.captureD1Row(input.metadata, bytes); break;
        case 'captureGithubFile': result = await capture.captureGithubFile(input.metadata, bytes); break;
        case 'awaitHeadRead': {
          const gate = readGate(input.headReadBarrier.id);
          await waitForState(() => gate.reached, 5000, 'synthetic_read_barrier_timeout');
          result = { reached: gate.reached, stage: gate.stage }; break;
        }
        case 'releaseHeadRead': {
          const gate = readGate(input.headReadBarrier.id);
          if (!gate.reached) throw Error('synthetic_read_not_paused');
          gate.released = true; result = { released: true }; break;
        }
        case 'advanceHead': result = await heads.advanceHead(input.headRequest); break;
        case 'rollbackHead': result = await heads.rollbackHead(input.headRequest); break;
        case 'fenceHead': result = await heads.fenceHead(input.headRequest); break;
        case 'readCandidate': {
          result = await heads.readCandidate(input.headRequest);
          if (result) result = { ...result, bytes: [...result.bytes] };
          break;
        }
        case 'apiShape': result = { store: Object.keys(store).sort(), capture: Object.keys(capture).sort(), heads: Object.keys(heads).sort() }; break;
        case 'outboundProbe': {
          const response = await fetch('https://network-must-not-be-used.invalid/');
          result = { status: response.status, body: await response.text() }; break;
        }
        default: throw Error('unknown_synthetic_operation');
      }
      return Response.json({ ok: true, result, counts });
    } catch (error) {
      return Response.json({ ok: false, error: error.message, counts });
    }
  },
};
