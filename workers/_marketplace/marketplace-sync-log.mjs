/**
 * Bookkeeping for the marketplace_sync_log table — one row per sync run.
 *
 * Every ERP sync engine opens a row before it fetches and closes it when it
 * knows the outcome, so a run that dies mid-flight stays visible as 'running'
 * rather than vanishing. The three calls were copy-pasted byte-for-byte between
 * erp-sales-sync.mjs and erp-stocks-sync.mjs; a column added to the table, or a
 * change to how far an error message is truncated, had to be made twice and
 * could land in one engine only. They live here once now.
 */

export async function beginLog(env, marketplace) {
  const started = Math.floor(Date.now() / 1000);
  const res = await env.ERP_DB.prepare(
    "INSERT INTO marketplace_sync_log (marketplace, started_at, status) VALUES (?, ?, 'running')"
  )
    .bind(marketplace, started)
    .run();
  return { logId: res.meta.last_row_id, started };
}

export async function finishOk(env, logId, rows) {
  await env.ERP_DB.prepare(
    "UPDATE marketplace_sync_log SET finished_at = ?, status = 'ok', rows_synced = ?, error_message = NULL WHERE id = ?"
  )
    .bind(Math.floor(Date.now() / 1000), rows, logId)
    .run();
}

export async function finishErr(env, logId, message) {
  await env.ERP_DB.prepare(
    "UPDATE marketplace_sync_log SET finished_at = ?, status = 'error', error_message = ? WHERE id = ?"
  )
    .bind(Math.floor(Date.now() / 1000), String(message).slice(0, 900), logId)
    .run();
}
