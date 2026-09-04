import assert from 'node:assert/strict';
import fs from 'node:fs';

const api = fs.readFileSync(new URL('./ga4.ts', import.meta.url), 'utf8');
const ui = fs.readFileSync(new URL('../../../web/app/analytics/tabs/SnapshotTab.tsx', import.meta.url), 'utf8');
const types = fs.readFileSync(new URL('../../../web/app/analytics/shared.tsx', import.meta.url), 'utf8');
const checks = [
  ['API requests page title and path together', api.includes("dimensions: [{ name: 'unifiedScreenName' }, { name: 'pagePath' }]")],
  ['API maps the page path', api.includes("page: r.dimensionValues?.[1]?.value || '(not set)'" )],
  ['API requests commerce events by title and path', api.includes("dimensions: [{ name: 'eventName' }, { name: 'unifiedScreenName' }, { name: 'pagePath' }]")],
  ['API exposes attributed commerce rows', api.includes('commerce_rows') && api.includes("event: r.dimensionValues?.[0]?.value" )],
  ['content cache invalidates partial-funnel rows', api.includes("cacheKey('ga4:content:v4'")],
  ['commerce attribution includes cart and bundle progression', api.includes("'view_cart'") && api.includes("'shipping_preview_ready'") && api.includes("'shipping_bundle_offer'") && api.includes("'shipping_bundle_add'")],
  ['commerce attribution includes checkout progression', api.includes("'checkout_loaded'") && api.includes("'checkout_address_complete'") && api.includes("'shipping_quote_ready'") && api.includes("'add_payment_info'")],
  ['shared content type keeps page', types.includes('rows: Array<{ title: string; page: string; views: number }>')],
  ['shared content type includes commerce rows', types.includes('commerce_rows: Array<{ event: string; title: string; page: string; count: number }>')],
  ['UI renders page title and path', ui.includes('Page title and path') && ui.includes('{r.page}')],
  ['UI renders attributed commerce rows', ui.includes('content.data?.commerce_rows') && ui.includes('Commerce event and page')],
];
for (const [label, pass] of checks) assert.equal(pass, true, label);
console.log(`GA4 content path contract passed: ${checks.length}/${checks.length} invariants.`);
