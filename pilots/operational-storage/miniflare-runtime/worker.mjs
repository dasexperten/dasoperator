/** Synthetic test harness only. No remote bindings or deploy configuration. */
import { createPilotStore } from '../store.mjs';
import { createOperationalCapture } from '../capture.mjs';
import { createMemoryHead } from '../memory-head.mjs';

// A local barrier forces competing synthetic requests to reach their native D1
// INSERT before either commits. It does not emulate D1 or modify adapter code.
const barriers = new Map();
async function beforeHeadInsert(id) {
  if (!id) return;
  let barrier = barriers.get(id);
  if (!barrier) {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    barrier = { count: 0, promise, release };
    barriers.set(id, barrier);
  }
  if (++barrier.count === 2) { barriers.delete(id); barrier.release(); }
  let timer;
  try {
    await Promise.race([barrier.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('synthetic_barrier_timeout')), 3000); })]);
  } finally { clearTimeout(timer); }
}

// Deterministic stale-read schedules for exact idempotency regressions. Native
// D1 first() completes before the request is paused; another request then commits.
const stagedReads = new Map();
function readGate(id) {
  let gate = stagedReads.get(id);
  if (!gate) {
    let arrive, release;
    const arrived = new Promise(resolve => { arrive = resolve; });
    const released = new Promise(resolve => { release = resolve; });
    gate = { arrived, released, arrive, release, reached: false };
    stagedReads.set(id, gate);
  }
  return gate;
}
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('synthetic_read_barrier_timeout')), 5000); })]);
  } finally { clearTimeout(timer); }
}
async function afterNativeRead(id, stage) {
  const gate = readGate(id);
  gate.reached = true;
  gate.stage = stage;
  gate.arrive();
  try { await bounded(gate.released); }
  finally { stagedReads.delete(id); }
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
        async run(...args) {
          const isHead = sql.includes('INSERT INTO pilot_working_memory_transitions');
          if (isHead) { counts.headWrites++; await beforeHeadInsert(input.headBarrier); }
          const result = await native.run(...args);
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
      let result;
      const bytes = input.bytes === undefined ? undefined : new Uint8Array(input.bytes);
      switch (input.operation) {
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
          await bounded(gate.arrived);
          result = { reached: gate.reached, stage: gate.stage }; break;
        }
        case 'releaseHeadRead': {
          const gate = readGate(input.headReadBarrier.id);
          if (!gate.reached) throw Error('synthetic_read_not_paused');
          gate.release(); result = { released: true }; break;
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
