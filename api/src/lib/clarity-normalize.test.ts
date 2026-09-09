import assert from 'node:assert/strict';
import { clarityCacheKey, normalizeClarity } from './clarity.ts';

const normalized = normalizeClarity([
  {
    metricName: 'DeadClickCount',
    information: [{ subTotal: 137, sessionsWithMetricPercentage: 6.57 }],
  },
  {
    metricName: 'QuickbackClick',
    information: [{ subTotal: 137, sessionsWithMetricPercentage: 10.95 }],
  },
  {
    metricName: 'Traffic',
    information: [{ totalSessionCount: 137, totalBotSessionCount: 72, distinctUserCount: 228 }],
  },
  {
    metricName: 'RageClickCount',
    information: [{ sessionsCount: 137, subTotal: 137, sessionsWithMetricPercentage: 2.92 }],
  },
], 3);

assert.equal(normalized.totals.sessions, 137);
assert.equal(normalized.signals.dead_click?.sessions_count, 9);
assert.equal(normalized.signals.quickback?.sessions_count, 15);
assert.equal(normalized.signals.rage_click?.sessions_count, 4);
assert.equal(clarityCacheKey(3), 'clarity:behavior:v3|days=3');

console.log('PASS 5/5 Clarity signal-count normalization checks');
