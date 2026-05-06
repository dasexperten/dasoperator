// =============================================================================
// Cron handler — dispatches by cron expression (wrangler.toml [triggers])
//
// "0 12 * * *"   — daily FX refresh from CBR (Phase 2.0c-2b)
// "0 * * * *"    — hourly marketplace stock refresh from Ozon + WB (Phase 6.0b)
//
// Marketplace sync calls go through self-fetch to the worker's own POST
// endpoints, so cron and manual triggers share the exact same code path.
// =============================================================================

import type { Env } from './types';
import { todayUtcDate, refreshFxFromCbr } from './lib/fx-cbr';
import { storeSnapshot } from './lib/fx-store';

export async function handleScheduled(
  event: ScheduledEvent,
  env: Env,
  _ctx: ExecutionContext
): Promise<void> {
  const cron = event.cron;
  console.log(`[cron] tick: ${cron}`);

  if (cron === '0 12 * * *') {
    await runFxRefresh();
    return;
  }

  if (cron === '0 * * * *') {
    await runMarketplaceSync();
    return;
  }

  console.warn(`[cron] no handler for cron expression: ${cron}`);

  // FX refresh — daily, internal libs, no self-fetch needed
  async function runFxRefresh(): Promise<void> {
    const date = todayUtcDate();
    console.log(`[cron] FX refresh starting for ${date}`);
    const snapshot = await refreshFxFromCbr(date);
    if (!snapshot) {
      console.error(`[cron] FX refresh FAILED for ${date} — CBR unreachable. Stale snapshot retained.`);
      return;
    }
    await storeSnapshot(env.FX, snapshot);
    console.log(`[cron] FX refresh complete for ${date}, ${Object.keys(snapshot.rates).length} rates cached`);
  }
}

// =============================================================================
// Marketplace hourly sync
// =============================================================================
//
// Cloudflare Workers cannot resolve their own external hostname during a
// scheduled event (no Request context to derive base URL from). We hit the
// public worker URL directly — DNS/Cloudflare routing handles the rest.
//
// Order matters: Ozon first (no rate-limit issue), then WB (1 req/min).
// If Ozon fails, we still try WB. Errors are logged inside each endpoint
// to marketplace_sync_log — no need to throw here, the log is the source
// of truth for /marketplaces page.
// =============================================================================

const SELF_BASE = 'https://dasoperator-api.dasexperten.workers.dev';

async function runMarketplaceSync(): Promise<void> {
  console.log('[cron] marketplace sync starting');

  try {
    const r = await fetch(`${SELF_BASE}/api/marketplaces/sync/ozon`, { method: 'POST' });
    console.log(`[cron] ozon sync HTTP ${r.status}`);
  } catch (e) {
    console.error('[cron] ozon sync threw:', e);
  }

  // Brief pause before WB so we don't pile parallel egress requests
  await new Promise((r) => setTimeout(r, 2000));

  try {
    const r = await fetch(`${SELF_BASE}/api/marketplaces/sync/wb`, { method: 'POST' });
    console.log(`[cron] wb sync HTTP ${r.status}`);
  } catch (e) {
    console.error('[cron] wb sync threw:', e);
  }

  console.log('[cron] marketplace sync done');
}
