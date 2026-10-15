#!/usr/bin/env node
// One historical AIR receipt only. Stock arithmetic remains in inventory.ts.
import { createHash } from 'node:crypto';
import { readFile, open, unlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { applyMovement, validateSign } from '../../api/src/lib/inventory.ts';

export const OP = 'op_198986d0-0688-49fe-a404-cbe5724d12c2';
export const SOURCE_SHA256 = 'd3020a3902db0779f05fa45cbab6f184ff6198fd759c0f5ffae0e94a3718d43f';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ACCOUNT = '081ddb85cb399ad62a70210328d744fc';
const DATABASE = '0653d156-5069-4c46-a496-fad982d0d1df';
export const LINES = [
  ['de202', 'li_04c43c5d-036d-4538-8a05-4e5ec43e2f21'],
  ['de203', 'li_8129f8f1-dfeb-4b45-a79b-a05ec2ca40e0'],
  ['de205', 'li_3ec277ce-10e3-4830-afe8-4c6a0e30157d'],
  ['de210', 'li_729104f4-5e23-4663-9864-4d5b3642eb47'],
];
const PRODUCTS = LINES.map(([sku]) => sku);
const hash = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const requireThat = (value, message) => { if (!value) throw new Error(message); };
export const marker = (sku) => `AIR-RECEIPT:${OP}:${LINES.find(([id]) => id === sku)[1]}:swh`;

export function receiptInput(sku) {
  requireThat(PRODUCTS.includes(sku), 'Product outside receipt scope');
  return {
    warehouse_id: 'swh', product_id: sku, movement_type: 'receipt', quantity: 144,
    source: 'manual', source_ref_type: 'operation', source_ref_id: OP,
    reason: 'AIR physical receipt confirmed by SwiftHub', performed_by: 'zina-pevtsova',
    notes: `${marker(sku)} | WDAA-26091601; FedEx AWB 877282467124. ` +
      `On 2026-10-15 at 13:47 Yerevan ` +
      `Phong confirmed receipt of ${sku.toUpperCase()} 144 tubes / 2 cartons, 70 ml; Owner confirmed at 14:02. ` +
      `Shipment total 576 tubes / 8 cartons. Posted at current posting time, without backdating. ` +
      `Condition/QA and current available balance are not established; this receipt is not an inventory count.`,
    // No performed_at: the unchanged primitive supplies the current execution time.
  };
}

// The only adapter: D1 prepared-statement interface -> existing management API.
// No SQL arithmetic or stock workflow is implemented here.
export function managementDb(env = process.env, fetcher = fetch) {
  const token = env.CLOUDFLARE_API_TOKEN;
  requireThat(token, 'CLOUDFLARE_API_TOKEN is required (existing vault/env only)');
  requireThat(env.CLOUDFLARE_ACCOUNT_ID === ACCOUNT, 'Unexpected Cloudflare account');
  requireThat(env.CLOUDFLARE_DATABASE_ID === DATABASE, 'Unexpected D1 database');
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/query`;
  return { prepare(sql) { return { bind(...params) {
    async function execute() {
      let response;
      try {
        response = await fetcher(url, {
          method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ sql, params }), signal: AbortSignal.timeout(45_000),
        });
      } catch { throw new Error('D1 transport failure; outcome must be read before any retry'); }
      requireThat(response.ok, `D1 management HTTP ${response.status}; response body withheld`);
      let body;
      try { body = await response.json(); } catch { throw new Error('D1 returned invalid JSON; outcome unknown'); }
      requireThat(body.success === true && body.result?.length === 1 && body.result[0].success === true,
        'D1 query failed; provider details withheld');
      requireThat(Array.isArray(body.result[0].results), 'D1 result rows missing');
      return body.result[0];
    }
    return { first: async () => (await execute()).results[0] ?? null,
      all: execute, run: execute };
  } }; } };
}

const rows = async (db, sql, ...params) => (await db.prepare(sql).bind(...params).all()).results;
export async function snapshot(db) {
  const [warehouse, company, operations, lines, products, stocks, movements, sessions, otherStocks] = await Promise.all([
    rows(db, 'SELECT id,code,country,owner_company_id,deleted_at FROM warehouses WHERE id=?', 'swh'),
    rows(db, 'SELECT id,legal_name,jurisdiction,deleted_at FROM companies WHERE id=?', 'dasean'),
    rows(db, 'SELECT * FROM operations WHERE id=?', OP),
    rows(db, 'SELECT * FROM line_items WHERE operation_id=? ORDER BY product_id,id', OP),
    rows(db, 'SELECT id,deleted_at FROM products WHERE id IN (?,?,?,?) ORDER BY id', ...PRODUCTS),
    rows(db, 'SELECT * FROM stocks WHERE warehouse_id=? ORDER BY product_id,stock_state,id', 'swh'),
    rows(db, `SELECT * FROM stock_movements WHERE warehouse_id=? OR source_ref_id=?
      OR instr(COALESCE(notes,''),?)>0 OR instr(COALESCE(notes,''),?)>0 ORDER BY id`,
    'swh', OP, `AIR-RECEIPT:${OP}:`, '877282467124'),
    rows(db, 'SELECT * FROM inventory_sessions WHERE warehouse_id=? ORDER BY id', 'swh'),
    rows(db, `SELECT * FROM stocks WHERE warehouse_id IN ('gzh','otw')
      AND product_id IN (?,?,?,?) ORDER BY warehouse_id,product_id,stock_state,id`, ...PRODUCTS),
  ]);
  return { warehouse, company, operations, lines, products, stocks, movements, sessions, otherStocks };
}

export function validateSnapshot(s) {
  const w = s.warehouse[0], c = s.company[0], op = s.operations[0];
  requireThat(s.warehouse.length === 1 && w.code === 'SWH' && w.country === 'Vietnam' &&
    w.owner_company_id === 'dasean' && w.deleted_at === null, 'SwiftHub warehouse/company mismatch');
  requireThat(s.company.length === 1 && c.id === 'dasean' && c.legal_name === 'Das Experten ASEAN Co. Ltd.' &&
    c.jurisdiction === 'Vietnam' && c.deleted_at === null, 'DASEAN company mismatch');
  requireThat(s.operations.length === 1 && op.reference === 'WDAA-26091601' && op.operation_type === 'purchase' &&
    op.operation_track === 'goods' && op.our_company_id === 'dasean' && op.warehouse_from_id === 'gzh' &&
    op.warehouse_to_id === null && op.status === 'issued' && op.delivery_status === 'delivered' &&
    op.deleted_at === null, 'Historical AIR operation changed; stop for review');
  requireThat(s.lines.length === 4 && LINES.every(([sku, id]) => s.lines.some((li) =>
    li.id === id && li.product_id === sku && li.qty === 144 && li.cartons === 2 && li.inner_boxes === 12)),
  'AIR line IDs/quantities/packing mismatch');
  requireThat(s.products.length === 4 && s.products.every((p) => PRODUCTS.includes(p.id) && p.deleted_at === null),
    'Receipt product missing or deleted');
  requireThat(s.sessions.length === 0, 'SwiftHub count session/cutoff exists; do not replay receipts');

  const complete = [];
  for (const m of s.movements) {
    const input = PRODUCTS.includes(m.product_id) ? receiptInput(m.product_id) : null;
    requireThat(input && m.warehouse_id === 'swh' && m.movement_type === 'receipt' && m.quantity === 144 &&
      m.balance_after === 144 && m.stock_state === 'on_hand' && m.source === 'manual' &&
      m.source_ref_type === 'operation' && m.source_ref_id === OP && m.performed_by === 'zina-pevtsova' &&
      m.reason === input.reason && m.notes === input.notes && Number.isInteger(m.performed_at) && m.performed_at > 0,
    'Unexplained or conflicting SWH/AIR receipt movement; stop for reconciliation');
    requireThat(!complete.includes(m.product_id), 'Duplicate receipt movement; do not add another');
    complete.push(m.product_id);
  }
  requireThat(s.stocks.length === complete.length && s.stocks.every((st) =>
    complete.includes(st.product_id) && st.stock_state === 'on_hand' && st.on_hand === 144 &&
    !st.last_counted_at && !st.last_counted_by) && new Set(s.stocks.map((st) => st.product_id)).size === complete.length,
  'Stock-only partial write, unexpected balance/state or count cutoff; do not retry');
  return complete;
}

const protectedHash = (s) => hash({ warehouse: s.warehouse, company: s.company, operations: s.operations,
  lines: s.lines, products: s.products, sessions: s.sessions, otherStocks: s.otherStocks });
const safeReadback = (s) => ({
  balances: s.stocks.map(({ id, product_id, stock_state, on_hand }) => ({ id, product_id, stock_state, on_hand })),
  movements: s.movements.map(({ id, product_id, quantity, balance_after, performed_at, source, source_ref_type, source_ref_id }) =>
    ({ id, product_id, quantity, balance_after, performed_at, source, source_ref_type, source_ref_id })),
});

export async function runReceipt(db, { apply = false, emit = () => {}, move = applyMovement } = {}) {
  const baseline = await snapshot(db);
  const already = validateSnapshot(baseline);
  const protectedBefore = protectedHash(baseline);
  emit({ stage: 'preflight', apply, company: baseline.company[0], warehouse: baseline.warehouse[0],
    already_recorded: already, pending: PRODUCTS.filter((p) => !already.includes(p)) });
  if (!apply) return { mode: 'dry-run', writes: 0, pending_inputs: PRODUCTS.filter((p) => !already.includes(p)).map(receiptInput),
    ...safeReadback(baseline) };

  let writes = 0;
  for (const sku of PRODUCTS) {
    const before = await snapshot(db); // Fresh dedup before EACH possible write.
    const complete = validateSnapshot(before);
    requireThat(protectedHash(before) === protectedBefore, 'Protected operation/lines/supplier/OTW changed; stop');
    if (complete.includes(sku)) { emit({ stage: 'already-verified', product_id: sku }); continue; }
    const input = receiptInput(sku);
    requireThat(!validateSign(input) && !Object.hasOwn(input, 'performed_at'), 'Receipt input/time invalid');
    let result;
    try { result = await move(db, input); }
    catch {
      // Never retry: applyMovement performs stock UPSERT before movement INSERT.
      let readback;
      try { readback = safeReadback(await snapshot(db)); } catch { readback = { unavailable: true }; }
      emit({ stage: 'ambiguous-write-stopped', product_id: sku, completed_calls: writes, ...readback });
      throw new Error(`Stopped after ambiguous write for ${sku}; inspect BOTH journal and balance, never blindly retry`);
    }
    writes++;
    const after = await snapshot(db);
    const afterComplete = validateSnapshot(after);
    requireThat(protectedHash(after) === protectedBefore, 'Protected state changed after receipt; stop');
    const saved = after.movements.find((m) => m.id === result.movement_id && m.product_id === sku);
    requireThat(afterComplete.includes(sku) && saved && result.balance_after === 144,
      'Receipt response/readback mismatch; stop without retry');
    emit({ stage: 'receipt-verified', ...result, performed_at: saved.performed_at });
  }
  const final = await snapshot(db);
  requireThat(validateSnapshot(final).length === 4 && protectedHash(final) === protectedBefore, 'Final receipt verification failed');
  return { mode: 'applied', writes, total_receipt_quantity: 576, protected_state_unchanged: true, ...safeReadback(final) };
}

export async function verifySource() {
  requireThat(hash(await readFile(resolve(ROOT, 'api/src/lib/inventory.ts'), 'utf8')) === SOURCE_SHA256,
    'inventory.ts differs from reviewed source; do not execute');
}

function verifyApplyTree() {
  const git = (...args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  requireThat(git('status', '--porcelain') === '', 'Apply requires a clean checkout');
  const head = git('rev-parse', 'HEAD');
  const remote = git('ls-remote', 'origin', 'refs/heads/main').split(/\s+/)[0];
  requireThat(/^[0-9a-f]{40}$/.test(remote) && head === remote, 'Apply requires HEAD identical to pushed origin/main');
  return head;
}

async function main() {
  const args = process.argv.slice(2);
  requireThat(args.every((a) => ['--apply', '--help'].includes(a)) && new Set(args).size === args.length, 'Use --help or --apply only');
  if (args.includes('--help')) {
    console.log('Node >=24. Default: read-only live preflight. --apply: exactly four SWH AIR receipts, resume by verification.\n' +
      'Requires existing env CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_DATABASE_ID. No credentials are printed.');
    return;
  }
  await verifySource();
  const apply = args.includes('--apply');
  const commit = apply ? verifyApplyTree() : null;
  const lock = resolve(tmpdir(), 'dasoperator-swifthub-air-receipt.lock');
  let handle;
  try {
    if (apply) handle = await open(lock, 'wx', 0o600); // Another local executor must stop; no stale-lock deletion.
    const emit = (event) => console.log(JSON.stringify(event));
    const result = await runReceipt(managementDb(), { apply, emit });
    emit({ ...result, source_sha256: SOURCE_SHA256, execution_commit: commit });
  } finally {
    if (handle) { await handle.close(); await unlink(lock); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // Only our own fixed messages: never provider response bodies, env or stack.
    console.error(JSON.stringify({ stopped: true, message: error instanceof Error ? error.message : 'Unknown failure' }));
    process.exitCode = 1;
  });
}
