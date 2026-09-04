import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const api = fs.readFileSync(new URL('./ga4.ts', import.meta.url), 'utf8');
const shared = fs.readFileSync(new URL('../../../web/app/analytics/shared.tsx', import.meta.url), 'utf8');
const snapshot = fs.readFileSync(new URL('../../../web/app/analytics/tabs/SnapshotTab.tsx', import.meta.url), 'utf8');

test('content report preserves the page path behind each title', () => {
  assert.match(api, /cacheKey\('ga4:content:v2'/);
  assert.match(api, /dimensions: \[\{ name: 'unifiedScreenName' \}, \{ name: 'pagePath' \}\]/);
  assert.match(api, /page: r\.dimensionValues\?\.\[1\]\?\.value \|\| '\(not set\)'/);
  assert.match(shared, /rows: Array<\{ title: string; page: string; views: number \}>/);
  assert.match(snapshot, /Page title and path/);
  assert.match(snapshot, /\{r\.page\}/);
});
