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
  [api.includes("cacheKey('ga4:commerce-losses:v12'"), 'commerce cache key invalidates the incorrect UTC price-test seam'],
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
  [api.includes("const PRICE_TEST_START_UTC = '2026-09-04T09:46:00Z'") && api.includes("const PRICE_TEST_END_UTC = '2026-09-11T09:46:00Z'"), 'price-test cohort retains the approved seven-day UTC release seam'],
  [api.includes('resp.metadata?.timeZone') && api.includes('minuteInTimeZone(PRICE_TEST_START_UTC, propertyTimeZone)'), 'price-test UTC seam uses timezone from the same GA4 report response'],
  [api.includes("ga4.get('/price-test-exposure'") && api.includes('https://jurgen-seo.dasexperten.com/ads-price-test-exposure'), 'API relays the bounded Jurgen Ads exposure feed'],
  [api.includes("code: 'ads_exposure_upstream_error'") && !api.includes('price-test-exposure?gaql='), 'Ads exposure proxy has explicit failure handling and no free-form query'],
  [api.includes("priceTestEventTotal('paid_locale_landing_tl', 'Philippines', '/tl/products/innoweiss')") && api.includes("priceTestEventTotal('add_to_cart', 'Philippines', '/tl/products/innoweiss')"), 'Philippines price test excludes pre-launch and non-INNOWEISS events'],
  [api.includes("priceTestEventTotal('paid_locale_landing_ms', 'Malaysia', '/ms/products/innoweiss')") && api.includes("priceTestEventTotal('add_to_cart', 'Malaysia', '/ms/products/innoweiss')"), 'Malaysia price test excludes pre-launch and non-INNOWEISS events'],
  [types.includes('price_test?: {') && types.includes('start_utc: string') && types.includes('property_time_zone: string') && types.includes('boundary_source: string'), 'shared type exposes authoritative UTC and property-local price-test boundaries'],
  [types.includes('export type AdsPriceTestExposure') && types.includes("Record<'PH' | 'MY' | 'VN'"), 'shared type bounds Ads exposure to the three test markets'],
  [ui.includes('losses.data?.market_totals.vn_add_to_cart'), 'dashboard consumes the complete Vietnam cart total'],
  [ui.includes('vnCartAdds / paidVnLandings'), 'dashboard computes Vietnam landing-to-cart signal ratio'],
  [ui.includes('VN landing → cart'), 'dashboard renders Vietnam landing-to-cart KPI'],
  [ui.includes('PH ₱499 landing → cart') && ui.includes('losses.data?.price_test?.ph_paid_landing') && ui.includes('phCartAdds / paidPhLandings'), 'dashboard renders bounded Philippines price-test conversion'],
  [ui.includes('MY RM29.90 landing → cart') && ui.includes('losses.data?.price_test?.my_paid_landing') && ui.includes('myCartAdds / paidMyLandings'), 'dashboard renders bounded Malaysia discount-test conversion'],
  [ui.includes('paidPhLandings > 0 ?') && ui.includes(': null') && ui.includes('paidMyLandings > 0 ?'), 'zero exposure renders an unavailable rate instead of a false zero percent'],
  [ui.includes("useApi<AdsPriceTestExposure>('/api/ga4/price-test-exposure')") && ui.includes('PH/MY price cards below use the exact GA4 release seam'), 'dashboard separates Ads calendar delivery from exact GA4 price-test conversion'],
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
