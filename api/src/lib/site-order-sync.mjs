/**
 * Оплаченные заказы .ru → повтор отправления, статусы частей и письма.
 *
 * Витрина держит персональные данные и сама разговаривает с Ozon. Сиденье
 * Даши только будит обезличенную служебную ручку и пишет результат в лог.
 * SITE_SYNC_TOKEN уже используется тем же сиденьем для stock-sync.
 */
const SITE_ORDER_SYNC = "https://dasexperten.ru/api/order/track.php";

// A successful polling request is not a successful delivery retry. Keep failed
// orders visible to the existing cron journal and persistent-failure monitor.
export function deliveryRetryOutcome(body) {
  if (!body || body.ok !== true) return body;
  const failed = (Array.isArray(body.retry_results) ? body.retry_results : [])
    .filter(result => result?.ok === false);
  if (!failed.length) return body;
  const reasons = [...new Set(failed.map(result =>
    /^[A-Za-z_0-9-]{1,80}$/.test(String(result.reason)) ? String(result.reason) : 'unknown'
  ))];
  return { ...body, ok: false, error: `Delivery retries unresolved: ${failed.length}; ${reasons.join(', ')}` };
}

export async function syncOzonOrdersOnSite(env) {
  const token = String(env.SITE_SYNC_TOKEN || "").trim();
  if (!token) return { ok: false, error: "SITE_SYNC_TOKEN не задан на сиденье" };

  try {
    const resp = await fetch(SITE_ORDER_SYNC, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sync-Token": token },
      body: JSON.stringify({ limit: 20, retry_limit: 20 }),
      signal: AbortSignal.timeout(110000),
    });
    const text = await resp.text();
    let body;
    try { body = JSON.parse(text); }
    catch { body = { raw: text.slice(0, 500) }; }
    if (!resp.ok || !body.ok) {
      return { ok: false, error: `site HTTP ${resp.status}: ${JSON.stringify(body).slice(0, 500)}` };
    }
    return deliveryRetryOutcome(body);
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}
