import assert from 'node:assert/strict';
import fs from 'node:fs';

const api = fs.readFileSync(new URL('./ga4.ts', import.meta.url), 'utf8');
const ui = fs.readFileSync(new URL('../../../web/app/analytics/tabs/SnapshotTab.tsx', import.meta.url), 'utf8');
const types = fs.readFileSync(new URL('../../../web/app/analytics/shared.tsx', import.meta.url), 'utf8');
const checks = [
  ['API requests page title and path together', api.includes("dimensions: [{ name: 'unifiedScreenName' }, { name: 'pagePath' }]")],
  ['API maps the page path', api.includes("page: r.dimensionValues?.[1]?.value || '(not set)'" )],
  ['content cache invalidates title-only rows', api.includes("cacheKey('ga4:content:v2'")],
  ['shared content type keeps page', types.includes('rows: Array<{ title: string; page: string; views: number }>')],
  ['UI renders page title and path', ui.includes('Page title and path') && ui.includes('{r.page}')],
];
for (const [label, pass] of checks) assert.equal(pass, true, label);
console.log(`GA4 content path contract passed: ${checks.length}/${checks.length} invariants.`);
