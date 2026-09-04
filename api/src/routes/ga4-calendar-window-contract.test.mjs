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
  assert.equal(reportRanges.length, 14);
  assert.equal(previousRanges.length, 2);
});

test('corrected semantics cannot read stale inclusive-window cache entries', () => {
  assert.match(source, /calendar_window: 'exact-v2'/);
});
