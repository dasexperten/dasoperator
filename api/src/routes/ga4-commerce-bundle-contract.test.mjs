import fs from 'node:fs';

const api = fs.readFileSync(new URL('./ga4.ts', import.meta.url), 'utf8');
const ui = fs.readFileSync(new URL('../../../web/app/analytics/tabs/FunnelTab.tsx', import.meta.url), 'utf8');
const types = fs.readFileSync(new URL('../../../web/app/analytics/shared.tsx', import.meta.url), 'utf8');

const checks = [
  [api.includes("'shipping_bundle_offer'"), 'API requests bundle offer events'],
  [api.includes("'add_to_cart'"), 'API retains cart entry beyond realtime'],
  [api.includes("'shipping_bundle_add'"), 'API requests bundle add events'],
  [api.includes("'shipping_bundle_unavailable'"), 'API requests missing bundle outcomes'],
  [api.includes("cacheKey('ga4:acquisition-detail:v3'"), 'acquisition cache key invalidates old hourly entry'],
  [api.includes("{ name: 'landingPage' },\n            { name: 'date' },") && api.includes("date: ga4Date(r.dimensionValues?.[4]?.value ?? ''),"), 'acquisition rows expose an exact GA4 date without shifting existing dimensions'],
  [api.includes("cacheKey('ga4:commerce-losses:v11'"), 'commerce cache key invalidates pre-release price-test cohorts'],
  [api.includes('return days === 1 ? 300 : 3600;'), 'one-day decision reports refresh within five minutes'],
  [(api.match(/decisionCacheTtl\(days\)/g) || []).length === 2, 'both acquisition and commerce-loss reports use decision TTL'],
  [api.includes("'pdp_value_proof_view'"), 'API requests PDP value-proof visibility'],
  [api.includes("'pdp_price_view'"), 'API requests PDP price visibility'],
  [ui.includes("pdp_value_proof_view: 'Saw product value proof'"), 'dashboard labels value-proof visibility'],
  [ui.includes("pdp_price_view: 'Saw product price'"), 'dashboard labels price visibility'],
  [ui.includes("add_to_cart: 'Added to cart'"), 'dashboard labels cart entry'],
  [api.includes("'checkout_address_complete'"), 'API requests checkout address completion'],
  [api.includes("'checkout_email_complete'") && api.includes("'checkout_address_started'"), 'API requests checkout interaction stages'],
  [ui.includes("checkout_email_complete: 'Email completed'") && ui.includes("checkout_address_started: 'Address started'"), 'dashboard labels checkout interaction stages'],
  [ui.includes("checkout_address_complete: 'Address completed'"), 'dashboard labels checkout address completion'],
  [ui.includes("shipping_bundle_offer: 'Saw two-tube shipping value'"), 'dashboard labels offer'],
  [ui.includes("shipping_bundle_add: 'Added second tube'"), 'dashboard labels add'],
  [ui.includes("shipping_bundle_unavailable: 'Two-tube shipping offer unavailable'"), 'dashboard labels missing offer'],
  [ui.includes('bundleAdds / bundleOffers'), 'dashboard computes uptake from adds divided by offers'],
  [ui.includes('Shipping bundle offers'), 'dashboard renders cross-market experiment KPIs'],
  [ui.includes('DE · VN · PH'), 'dashboard names the measured market scope'],
  [ui.includes('Bundle uptake'), 'dashboard renders uptake KPI'],
  [api.includes("marketEventTotal('paid_locale_landing_vn', 'Vietnam')") && api.includes("marketEventTotal('add_to_cart', 'Vietnam')"), 'API aligns Vietnam numerator and denominator by country'],
  [api.includes("marketEventTotal('paid_locale_landing_tl', 'Philippines')") && api.includes("marketEventTotal('add_to_cart', 'Philippines')"), 'API totals Philippines price-test cohort before display limiting'],
  [api.includes("marketEventTotal('paid_locale_landing_ms', 'Malaysia')") && api.includes("marketEventTotal('add_to_cart', 'Malaysia')"), 'API totals Malaysia discount-test cohort before display limiting'],
  [types.includes('ph_paid_landing: number') && types.includes('my_add_to_cart: number'), 'shared response type exposes all test-market totals'],
  [api.includes("const PRICE_TEST_START_MINUTE = '202609040946'") && api.includes("const PRICE_TEST_END_MINUTE = '202609110946'"), 'price-test cohort is bounded by the approved seven-day release seam'],
  [api.includes("priceTestEventTotal('paid_locale_landing_tl', 'Philippines', '/tl/products/innoweiss')") && api.includes("priceTestEventTotal('add_to_cart', 'Philippines', '/tl/products/innoweiss')"), 'Philippines price test excludes pre-launch and non-INNOWEISS events'],
  [api.includes("priceTestEventTotal('paid_locale_landing_ms', 'Malaysia', '/ms/products/innoweiss')") && api.includes("priceTestEventTotal('add_to_cart', 'Malaysia', '/ms/products/innoweiss')"), 'Malaysia price test excludes pre-launch and non-INNOWEISS events'],
  [types.includes('price_test?: {') && types.includes('start_minute: string') && types.includes('end_minute: string'), 'shared type exposes the bounded price-test cohort with deploy-order tolerance'],
  [ui.includes('losses.data?.market_totals.vn_add_to_cart'), 'dashboard consumes the complete Vietnam cart total'],
  [ui.includes('vnCartAdds / paidVnLandings'), 'dashboard computes Vietnam landing-to-cart signal ratio'],
  [ui.includes('VN landing → cart'), 'dashboard renders Vietnam landing-to-cart KPI'],
  [ui.includes('PH ₱499 landing → cart') && ui.includes('losses.data?.price_test?.ph_paid_landing') && ui.includes('phCartAdds / paidPhLandings'), 'dashboard renders bounded Philippines price-test conversion'],
  [ui.includes('MY RM29.90 landing → cart') && ui.includes('losses.data?.price_test?.my_paid_landing') && ui.includes('myCartAdds / paidMyLandings'), 'dashboard renders bounded Malaysia discount-test conversion'],
  [ui.includes('paidPhLandings > 0 ?') && ui.includes(': null') && ui.includes('paidMyLandings > 0 ?'), 'zero exposure renders an unavailable rate instead of a false zero percent'],
  [api.includes("{ name: 'dateHourMinute' }") && api.includes('event_minute:'), 'API dates each loss against release seams'],
  [api.includes('limit: 10000') && api.includes('rows: rows.slice(0, limit)'), 'totals use the full minute-grain response before display limit'],
  [ui.includes('Minute · GA4') && ui.includes('gaMinute(row.event_minute)'), 'dashboard shows the event occurrence minute'],
];

const failures = checks.filter(([passed]) => !passed).map(([, label]) => label);
if (failures.length) {
  console.error(`GA4 bundle contract failed (${failures.length}):\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`GA4 bundle contract passed: ${checks.length}/${checks.length} invariants.`);
