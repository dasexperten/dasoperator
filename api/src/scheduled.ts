// =============================================================================
// Cron handler — daily FX refresh at 12:00 UTC
//
// Schedule defined in wrangler.toml [triggers] crons.
// Failure to fetch CBR is non-critical — last successful snapshot remains.
// =============================================================================

import type { Env } from './types';
import { todayUtcDate, refreshFxFromCbr } from './lib/fx-cbr';
import { storeSnapshot } from './lib/fx-store';

export async function handleScheduled(
  _event: ScheduledEvent,
  env: Env,
  _ctx: ExecutionContext
): Promise<void> {
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
