// Owner 2026-11-08: remove these named jobs, keeping their historical D1 data.
// Runs only from main CI with its existing secret; no credential leaves CI.
import { readFileSync, existsSync } from 'node:fs';
const names = JSON.parse(readFileSync(new URL('./erp-retired.json', import.meta.url)));
const base = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/`;
const headers = { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` };
for (const name of names) {
  if (!['erp-promo-refill', 'erp-ugc-payout-summary', 'erp-site-order-retry'].includes(name)) throw Error('Unapproved retirement');
  if (existsSync(new URL(`../workers/${name}/wrangler.toml`, import.meta.url))) throw Error(`${name}: source still deployable`);
  const url = base + name;
  const before = await fetch(url, { headers });
  if (before.status !== 404) {
    if (!before.ok) throw Error(`${name}: inspection failed (${before.status})`);
    const removed = await fetch(url, { method: 'DELETE', headers });
    if (!removed.ok) throw Error(`${name}: deletion failed (${removed.status})`);
    const result = await removed.json();
    if (!result.success) throw Error(`${name}: deletion not confirmed`);
  }
  const after = await fetch(url, { headers });
  if (after.status !== 404) throw Error(`${name}: still present (${after.status})`);
  console.log(`${name}: removed; script and timer absent`);
}
