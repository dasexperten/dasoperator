// Owner 2026-10-19: «подключить Мину к красному значку, чтобы причину разбирала она».
// The red «message not delivered» status hands the cause to Mina Rutunya (sysadmin) in the same event —
// no timer, no polling. One hand-off per payout; Mina fixes the cause, she does not restart blindly.
import type { Env } from '../types';

export async function alertMina(env: Env, a: { payoutId: string; handle: string; error: string; kind: 'paid' | 'failed' }): Promise<boolean> {
  const mina = (env as unknown as { MINA?: Fetcher }).MINA;
  const secret = env.EMAILER_SERVICE_SECRET;
  const key = `mina_alert:paid_notice:${a.payoutId}`;
  const once = await env.DB.prepare(`INSERT INTO crm_sync_state (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO NOTHING`)
    .bind(key, JSON.stringify({ ...a, at: new Date().toISOString(), delivered_to_mina: false }), Date.now()).run().catch(() => null);
  if ((once?.meta?.changes ?? 0) !== 1) return false;
  if (!mina || !secret) return false;
  const text = [
    `ERP, красный значок: сообщение о ${a.kind === 'failed' ? 'неудачной выплате' : 'переводе'} блогеру @${a.handle} не доставлено.`,
    `Причина, которую вернул Instagram или ERP: ${a.error}.`,
    `Выплата ${a.payoutId}. Найди причину в ERP (dasoperator) и почини её, не перезапуская вслепую.`,
    'Если причина в закрытом 7-дневном окне Instagram, это не дефект: сообщение ждёт в очереди браузера.',
  ].join('\n');
  const res = await mina.fetch('https://mina-sysadmin/adhoc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Emailer-Service-Secret': secret },
    body: JSON.stringify({ text, from: 'ERP' }),
    signal: AbortSignal.timeout(120_000),
  }).catch(() => null);
  const ok = Boolean(res && res.ok);
  await env.DB.prepare(`UPDATE crm_sync_state SET value=json_set(value,'$.delivered_to_mina',?2), updated_at=?3 WHERE key=?1`).bind(key, ok ? 1 : 0, Date.now()).run().catch(() => undefined);
  return ok;
}
