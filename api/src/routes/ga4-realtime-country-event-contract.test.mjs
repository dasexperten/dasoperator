import assert from 'node:assert/strict';
import fs from 'node:fs';

const api = fs.readFileSync(new URL('./ga4.ts', import.meta.url), 'utf8');
const ui = fs.readFileSync(new URL('../../../web/app/analytics/tabs/SnapshotTab.tsx', import.meta.url), 'utf8');
const types = fs.readFileSync(new URL('../../../web/app/analytics/shared.tsx', import.meta.url), 'utf8');

const checks = [
  ['API requests compatible country, event and screen dimensions', /dimensions: \[\{ name: 'country' \}, \{ name: 'eventName' \}, \{ name: 'unifiedScreenName' \}\]/.test(api)],
  ['GA4 filters to commerce events before applying the row limit', api.includes("fieldName: 'eventName'") && api.includes('inListFilter: { values: commerceEventNames }')],
  ['API exposes the joined rows', api.includes('by_country_event: countryEventRows')],
  ['API aggregates screen rows without invented minute precision', api.includes('countryEventMap') && api.includes('last_seen_minutes_ago: null')],
  ['API separates the same event by screen', api.includes('`${country}\\u0000${event}\\u0000${screen}`') && api.includes('screen,')],
  ['API keeps the paid landing signal', api.includes("'paid_locale_landing_vn'")],
  ['API keeps PDP value-proof visibility', api.includes("'pdp_value_proof_view'")],
  ['API keeps PDP price visibility', api.includes("'pdp_price_view'")],
  ['API keeps cart progression', api.includes("'add_to_cart'") && api.includes("'begin_checkout'")],
  ['API keeps bundle outcomes', api.includes("'shipping_bundle_offer'") && api.includes("'shipping_bundle_unavailable'") && api.includes("'shipping_bundle_add'")],
  ['API keeps purchase outcome', api.includes("'purchase'")],
  ['UI renders country-event-screen rows', ui.includes('rt.by_country_event') && ui.includes('<th>Screen</th>') && ui.includes('{r.screen}')],
  ['shared response type includes screen and nullable freshness', types.includes('screen: string; count: number; last_seen_minutes_ago: number | null')],
];

for (const [label, pass] of checks) {
  assert.equal(pass, true, label);
  console.log(`PASS ${label}`);
}
console.log(`${checks.length}/${checks.length} realtime country-event contract checks passed`);
