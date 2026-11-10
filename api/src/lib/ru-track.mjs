import { syncOzonOrdersOnSite } from './site-order-sync.mjs';

// The storefront's default limits are 20/20, identical to the retired retry
// worker. A successful HTTP response must not hide a failed delivery retry.
export async function runRuTrack(env) {
  const result = await syncOzonOrdersOnSite({ SITE_SYNC_TOKEN: env.RU_ADMIN_TOKEN });
  const complete = Number.isInteger(result?.checked) && Number.isInteger(result?.retried) &&
    Array.isArray(result?.results) && Array.isArray(result?.retry_results);
  const ok = result?.ok === true && complete;
  const mails = (Array.isArray(result?.results) ? result.results : []).filter(x => x?.mail_shipped === true).length;
  const status = ok ? `ok checked=${result.checked} retried=${result.retried} mails=${mails}` : String(result?.error || 'site order tracking returned incomplete results');
  const now = Date.now();
  const sql = `INSERT INTO crm_sync_state (key, value, updated_at) VALUES (?1, ?2, ?3)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`;
  await env.DB.batch([
    env.DB.prepare(sql).bind('ru_track:last_try_at', String(now), now),
    env.DB.prepare(sql).bind('ru_track:last_status', status, now),
    ...(ok ? [env.DB.prepare(sql).bind('ru_track:last_ok_at', String(now), now)] : []),
  ]);
  if (!ok) throw new Error(status);
  return `checked=${result.checked ?? '?'} retried=${result.retried ?? '?'} mails=${mails}`;
}
