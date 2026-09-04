import assert from 'node:assert/strict';
import fs from 'node:fs';

const api = fs.readFileSync(new URL('./ga4.ts', import.meta.url), 'utf8');
const ui = fs.readFileSync(new URL('../../../web/app/analytics/tabs/SnapshotTab.tsx', import.meta.url), 'utf8');
const types = fs.readFileSync(new URL('../../../web/app/analytics/shared.tsx', import.meta.url), 'utf8');

const checks = [
  ['Realtime avoids unsupported event and screen join', !api.includes('by_screen_event:') && !api.includes('byScreenEvent.rows')],
  ['Standard report owns event and screen attribution', api.includes("dimensions: [{ name: 'eventName' }, { name: 'unifiedScreenName' }, { name: 'pagePath' }]")],
  ['GA4 filters commerce events in the standard report', api.includes("fieldName: 'eventName'") && api.includes("'pdp_value_proof_view'")],
  ['API exposes page-attributed commerce rows', api.includes('commerce_rows')],
  ['UI reads page-attributed commerce rows', ui.includes('content.data?.commerce_rows')],
  ['API keeps the paid landing signal', api.includes("'paid_locale_landing_vn'")],
  ['API keeps PDP value-proof visibility', api.includes("'pdp_value_proof_view'")],
  ['API keeps PDP price visibility', api.includes("'pdp_price_view'")],
  ['API keeps cart progression', api.includes("'add_to_cart'") && api.includes("'begin_checkout'")],
  ['API keeps address completion', api.includes("'checkout_address_complete'")],
  ['API keeps checkout interaction stages', api.includes("'checkout_email_complete'") && api.includes("'checkout_address_started'")],
  ['API keeps bundle outcomes', api.includes("'shipping_bundle_offer'") && api.includes("'shipping_bundle_unavailable'") && api.includes("'shipping_bundle_add'")],
  ['API keeps purchase outcome', api.includes("'purchase'")],
  ['UI does not claim realtime screen attribution', !ui.includes('rt.by_screen_event')],
  ['shared content type carries page-attributed commerce', types.includes('commerce_rows: Array')],
];

for (const [label, pass] of checks) {
  assert.equal(pass, true, label);
  console.log(`PASS ${label}`);
}
console.log(`${checks.length}/${checks.length} realtime country-event contract checks passed`);
