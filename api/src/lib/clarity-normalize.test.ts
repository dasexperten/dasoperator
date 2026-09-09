import assert from 'node:assert/strict';
import { clarityCacheKey, normalizeClarity } from './clarity.ts';

const normalized = normalizeClarity([
  {
    metricName: 'DeadClickCount',
    information: [{ sessionsCount: 137, subTotal: 23, pagesViews: 12, sessionsWithMetricPercentage: 6.57 }],
  },
  {
    metricName: 'QuickbackClick',
    information: [{ sessionsCount: 137, subTotal: 43, pagesViews: 43, sessionsWithMetricPercentage: 10.95 }],
  },
  {
    metricName: 'Traffic',
    information: [{ totalSessionCount: 137, totalBotSessionCount: 72, distinctUserCount: 228 }],
  },
  {
    metricName: 'RageClickCount',
    information: [{ sessionsCount: 137, subTotal: 0, sessionsWithMetricPercentage: 0 }],
  },
  {
    metricName: 'ErrorClickCount',
    information: [{ sessionsCount: 137, sessionsWithMetricPercentage: 1.46 }],
  },
], 3);

assert.equal(normalized.totals.sessions, 137);
assert.equal(normalized.signals.dead_click?.sessions_count, 9);
assert.equal(normalized.signals.quickback?.sessions_count, 15);
assert.equal(normalized.signals.rage_click?.sessions_count, 0);
assert.equal(normalized.signals.error_click?.sessions_count, 2);
assert.equal(clarityCacheKey(3), 'clarity:behavior:v5|days=3');

console.log('PASS 6/6 Clarity signal-count normalization checks');
