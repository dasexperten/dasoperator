import assert from 'node:assert/strict';
import { clarityCacheKey, clarityUrlCacheKey, normalizeClarity, normalizeClarityByUrl } from './clarity.ts';

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

const byUrl = normalizeClarityByUrl([
  { metricName: 'QuickbackClick', information: [
    { Url: 'https://www.dasexperten.com/de/?utm_source=x', sessionsCount: 3, sessionsWithMetricPercentage: 66.67 },
    { Url: 'https://dasexperten.ru/', sessionsCount: 12, sessionsWithMetricPercentage: 25 },
  ] },
  { metricName: 'DeadClickCount', information: [
    { Url: 'https://www.dasexperten.com/de/', sessionsCount: 3, sessionsWithMetricPercentage: 33.33 },
    { Url: 'https://example.com/', sessionsCount: 99, sessionsWithMetricPercentage: 100 },
  ] },
], 3);

assert.equal(clarityUrlCacheKey(3), 'clarity:behavior-by-url:v1|days=3');
assert.deepEqual(byUrl.rows.map((row) => [row.url, row.sessions, row.quickback_sessions, row.dead_click_sessions]), [
  ['dasexperten.ru/', 12, 3, 0],
  ['dasexperten.com/de/', 3, 2, 1],
]);

console.log('PASS 8/8 Clarity signal and URL normalization checks');
