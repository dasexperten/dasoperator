import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('./ga4.ts', import.meta.url), 'utf8');

test('GA4 day windows contain exactly the requested calendar dates', () => {
  assert.match(source, /days === 1 \? 'today' : `\$\{days - 1\}daysAgo`/);
  assert.match(source, /startDate: `\$\{days \* 2 - 1\}daysAgo`, endDate: `\$\{days\}daysAgo`/);
  assert.doesNotMatch(source, /startDate: `\$\{days\}daysAgo`, endDate: 'today'/);
  assert.doesNotMatch(source, /startDate: `\$\{days \* 2\}daysAgo`, endDate: `\$\{days \+ 1\}daysAgo`/);
});

test('all standard GA4 report calls use the shared window contract', () => {
  const reportRanges = source.match(/dateRanges: \[reportRange\(days\)\]/g) ?? [];
  const previousRanges = source.match(/dateRanges: \[previousReportRange\(days\)\]/g) ?? [];
  assert.equal(reportRanges.length, 18);
  assert.equal(previousRanges.length, 2);
});

test('corrected semantics cannot read stale inclusive-window cache entries', () => {
  assert.match(source, /calendar_window: 'exact-v3'/);
  assert.doesNotMatch(source, /calendar_window: 'exact-v2'/);
});

test('every cached calendar report refreshes a one-day decision window within five minutes', () => {
  const cachedRoutes = source.match(/withKvCache\(/g) ?? [];
  const adaptiveTtls = source.match(/decisionCacheTtl\(days\)/g) ?? [];
  assert.equal(cachedRoutes.length, 11);
  assert.equal(adaptiveTtls.length, 11);
  assert.match(source, /return days === 1 \? 300 : 3600/);
  assert.doesNotMatch(source, /\), 3600, async \(\) =>/);
});
