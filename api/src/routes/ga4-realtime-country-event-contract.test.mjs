import assert from 'node:assert/strict';
import fs from 'node:fs';

const api = fs.readFileSync(new URL('./ga4.ts', import.meta.url), 'utf8');
const ui = fs.readFileSync(new URL('../../../web/app/analytics/tabs/SnapshotTab.tsx', import.meta.url), 'utf8');
const types = fs.readFileSync(new URL('../../../web/app/analytics/shared.tsx', import.meta.url), 'utf8');

const checks = [
  ['API requests the country and eventName dimensions together', /dimensions: \[\{ name: 'country' \}, \{ name: 'eventName' \}\]/.test(api)],
  ['GA4 filters to commerce events before applying the row limit', api.includes("fieldName: 'eventName'") && api.includes('inListFilter: { values: commerceEventNames }')],
  ['API exposes the joined rows', api.includes('by_country_event: countryEventRows')],
  ['API keeps the paid landing signal', api.includes("'paid_locale_landing_vn'")],
  ['API keeps cart progression', api.includes("'add_to_cart'") && api.includes("'begin_checkout'")],
  ['API keeps bundle outcomes', api.includes("'shipping_bundle_offer'") && api.includes("'shipping_bundle_add'")],
  ['API keeps purchase outcome', api.includes("'purchase'")],
  ['UI renders country-event rows', ui.includes('rt.by_country_event') && ui.includes('Commerce event')],
  ['shared response type includes country-event rows', types.includes('by_country_event?: Array<{ country: string; event: string; count: number }>')],
];

for (const [label, pass] of checks) {
  assert.equal(pass, true, label);
  console.log(`PASS ${label}`);
}
console.log(`${checks.length}/${checks.length} realtime country-event contract checks passed`);
