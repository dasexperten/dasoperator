import fs from 'node:fs';

const api = fs.readFileSync(new URL('./ga4.ts', import.meta.url), 'utf8');
const ui = fs.readFileSync(new URL('../../../web/app/analytics/tabs/FunnelTab.tsx', import.meta.url), 'utf8');

const checks = [
  [api.includes("'shipping_bundle_offer'"), 'API requests bundle offer events'],
  [api.includes("'shipping_bundle_add'"), 'API requests bundle add events'],
  [api.includes("cacheKey('ga4:acquisition-detail:v2'"), 'acquisition cache key invalidates old hourly entry'],
  [api.includes("cacheKey('ga4:commerce-losses:v3'"), 'commerce cache key invalidates old hourly entry'],
  [api.includes('return days === 1 ? 300 : 3600;'), 'one-day decision reports refresh within five minutes'],
  [(api.match(/decisionCacheTtl\(days\)/g) || []).length === 2, 'both acquisition and commerce-loss reports use decision TTL'],
  [api.includes("'pdp_value_proof_view'"), 'API requests PDP value-proof visibility'],
  [api.includes("'pdp_price_view'"), 'API requests PDP price visibility'],
  [ui.includes("pdp_value_proof_view: 'Saw product value proof'"), 'dashboard labels value-proof visibility'],
  [ui.includes("pdp_price_view: 'Saw product price'"), 'dashboard labels price visibility'],
  [ui.includes("shipping_bundle_offer: 'Saw two-tube shipping value'"), 'dashboard labels offer'],
  [ui.includes("shipping_bundle_add: 'Added second tube'"), 'dashboard labels add'],
  [ui.includes('bundleAdds / bundleOffers'), 'dashboard computes uptake from adds divided by offers'],
  [ui.includes('Shipping bundle offers'), 'dashboard renders cross-market experiment KPIs'],
  [ui.includes('DE · VN · PH'), 'dashboard names the measured market scope'],
  [ui.includes('Bundle uptake'), 'dashboard renders uptake KPI'],
];

const failures = checks.filter(([passed]) => !passed).map(([, label]) => label);
if (failures.length) {
  console.error(`GA4 bundle contract failed (${failures.length}):\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`GA4 bundle contract passed: ${checks.length}/${checks.length} invariants.`);
