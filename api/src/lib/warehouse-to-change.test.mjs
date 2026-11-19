import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url), { build } = require('esbuild');
const dir = mkdtempSync(join(tmpdir(), 'warehouse-to-'));
await build({ entryPoints: [fileURLToPath(new URL('./warehouse-to-change.ts', import.meta.url))], bundle: true,
  platform: 'node', format: 'esm', outfile: join(dir, 'lib.mjs') });
const { planDestinationChange } = await import(pathToFileURL(join(dir, 'lib.mjs')));
test.after(() => rmSync(dir, { recursive: true, force: true }));

const base = { fromWarehouseId: 'lbr', toWarehouseId: 'srn', movementType: 'arrival' };

test('no arrival yet: nothing to move', () => {
  assert.deepEqual(planDestinationChange({ ...base, arrivals: [], oldOnHand: {} }), { specs: [], shortages: [] });
});

test('received goods move as a pair dated at the original arrival', () => {
  const { specs, shortages } = planDestinationChange({ ...base,
    arrivals: [{ product_id: 'de202', quantity: 40896, performed_at: 1793022856 }],
    oldOnHand: { de202: 41498 } });
  assert.deepEqual(shortages, []);
  assert.deepEqual(specs, [
    { warehouseId: 'lbr', productId: 'de202', movementType: 'arrival', qty: -40896, reason: 'destination_corrected_out', performedAt: 1793022856 },
    { warehouseId: 'srn', productId: 'de202', movementType: 'arrival', qty: 40896, reason: 'destination_corrected_in', performedAt: 1793022856 },
  ]);
});

test('goods already sold from the old warehouse are refused, not driven negative', () => {
  const { specs, shortages } = planDestinationChange({ ...base,
    arrivals: [{ product_id: 'de203', quantity: 24192, performed_at: 1 }], oldOnHand: { de203: 1000 } });
  assert.deepEqual(specs, []);
  assert.deepEqual(shortages, [{ product_id: 'de203', on_hand: 1000, needed: 24192 }]);
});

test('an earlier correction out of this warehouse is netted, not moved twice', () => {
  const { specs } = planDestinationChange({ ...base,
    arrivals: [{ product_id: 'de205', quantity: 10800, performed_at: 5 }, { product_id: 'de205', quantity: -10800, performed_at: 5 }],
    oldOnHand: { de205: 276 } });
  assert.deepEqual(specs, []);
});
