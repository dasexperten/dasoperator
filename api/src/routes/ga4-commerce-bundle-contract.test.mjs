import fs from 'node:fs';

const api = fs.readFileSync(new URL('./ga4.ts', import.meta.url), 'utf8');
const ui = fs.readFileSync(new URL('../../../web/app/analytics/tabs/FunnelTab.tsx', import.meta.url), 'utf8');

const checks = [
  [api.includes("'shipping_bundle_offer'"), 'API requests bundle offer events'],
  [api.includes("'shipping_bundle_add'"), 'API requests bundle add events'],
  [api.includes("cacheKey('ga4:commerce-losses:v2'"), 'API cache key invalidates old event list'],
  [ui.includes("shipping_bundle_offer: 'Saw two-tube shipping value'"), 'dashboard labels offer'],
  [ui.includes("shipping_bundle_add: 'Added second tube'"), 'dashboard labels add'],
  [ui.includes('bundleAdds / bundleOffers'), 'dashboard computes uptake from adds divided by offers'],
  [ui.includes('DE bundle offers'), 'dashboard renders experiment KPIs'],
  [ui.includes('Bundle uptake'), 'dashboard renders uptake KPI'],
];

const failures = checks.filter(([passed]) => !passed).map(([, label]) => label);
if (failures.length) {
  console.error(`GA4 bundle contract failed (${failures.length}):\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`GA4 bundle contract passed: ${checks.length}/${checks.length} invariants.`);
