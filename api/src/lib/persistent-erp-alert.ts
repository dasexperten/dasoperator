// Owner 2026-10-03: temporary ERP failures stay in the journal. Report only
// repeated failures lasting at least a day; Modulbank never reports to Telegram.
import type { Env } from '../types';
import { sendOwnerTelegram } from './owner-telegram';

const DAY = 86400;
export interface FailureEpisode { count: number; first: number; last: number; notified: number | null }
export function shouldReportEpisode(service: string, episode: FailureEpisode, now: number): boolean {
  return !/modulbank|modulbankа|модульбанк/i.test(service)
    && episode.count >= 2 && episode.last - episode.first >= DAY
    && now - episode.last <= DAY
    && (episode.notified === null || now - episode.notified >= DAY);
}

const duties: Record<string, string> = {
  'watchdog:ozon_stocks': 'загрузка остатков Ozon в ERP',
  'watchdog:ozon_sales': 'загрузка продаж Ozon в ERP',
  'watchdog:wb_sales': 'загрузка продаж Wildberries в ERP',
  'watchdog:ozon_reviews': 'загрузка отзывов Ozon',
  'watchdog:wb_reviews': 'загрузка отзывов Wildberries',
  'watchdog:ozon_questions': 'загрузка вопросов Ozon',
  'watchdog:wb_questions': 'загрузка вопросов Wildberries',
  'watchdog:web_analytics': 'обновление аналитики сайтов',
  'watchdog:wb_backfill': 'загрузка истории Wildberries',
  'erp-ru-track': 'обновление статусов доставки заказов сайта',
  'erp-site-order-retry': 'повторная передача заказов сайта в доставку',
  'erp-site-stock': 'обновление остатков на сайте',
  'erp-ru-orders': 'загрузка заказов сайта в ERP',
  'erp-mail-snapshot': 'обновление почтового архива ERP',
  'erp-ozon-ads-poll': 'загрузка рекламных отчётов Ozon',
  'erp-marketplace-pull': 'загрузка данных маркетплейсов',
  'erp-social-queue': 'обработка очереди публикаций',
  web_analytics_nightly: 'ночное обновление аналитики сайтов',
  orders_drop_watchdog: 'проверка падения числа заказов',
};
export function persistentAlertText(service: string, episode: FailureEpisode, errorClass: string): string {
  const duty = duties[service] || (service.startsWith('web_analytics:')
    ? `загрузка аналитики ${service.split(':')[1]}`
    : `служба ERP «${service.replace(/^watchdog:/, '')}»`);
  const days = Math.max(1, Math.floor((episode.last - episode.first) / DAY));
  const proposal = errorClass === 'auth_failure'
    ? 'Предлагаю проверить действительность доступа и ответ площадки, затем повторить загрузку. Ключи без вашего указания не меняю.'
    : errorClass === 'schema_mismatch'
      ? 'Предлагаю сверить структуру базы с опубликованным кодом, исправить расхождение и проверить успешный запуск.'
      : errorClass === 'rate_limit' || errorClass === 'upstream_5xx' || errorClass === 'timeout'
        ? 'Предлагаю проверить доступность площадки и ограничения запросов, настроить повторы с паузой и проверить успешный запуск.'
        : 'Предлагаю разобрать журнал этой службы, исправить причину повторяющихся сбоев и проверить успешный запуск.';
  return `Шеф, ${duty} устойчиво сбоит: ${days} сут., ${episode.count} неудачных запусков без подтверждённого восстановления.\n\n${proposal}`;
}

export async function recordErpRecovery(env: Env, service: string): Promise<void> {
  // Write only when an unresolved failure exists, so healthy checks add no noise.
  await env.DB.prepare(`INSERT INTO auto_heal_log
    (id, recipe_id, service_name, triggered_by_error, action_taken, result, details, occurred_at, duration_ms)
    SELECT ?, NULL, ?, '', 'recovered', 'success', '{}', ?, 0
    WHERE EXISTS (SELECT 1 FROM sync_failures WHERE service_name = ? AND occurred_at >
      COALESCE((SELECT MAX(occurred_at) FROM auto_heal_log WHERE service_name = ? AND action_taken = 'recovered'), 0))`)
    .bind(`heal_${crypto.randomUUID()}`, service, Math.floor(Date.now() / 1000), service, service).run();
}

export async function notifyPersistentErpFailure(env: Env, service: string, failureId: string, errorClass: string): Promise<void> {
  if (/modulbank|модульбанк/i.test(service)) return;
  const episode = await env.DB.prepare(`SELECT COUNT(*) AS count, MIN(occurred_at) AS first,
    MAX(occurred_at) AS last, MAX(CASE WHEN notified = 1 THEN created_at END) AS notified
    FROM sync_failures WHERE service_name = ? AND occurred_at > MAX(
      COALESCE((SELECT MAX(CAST(strftime('%s', started_at) AS INTEGER)) FROM erp_cron_runs WHERE worker = ? AND ok = 1), 0),
      COALESCE((SELECT MAX(occurred_at) FROM auto_heal_log WHERE service_name = ? AND action_taken = 'recovered'), 0))`)
    .bind(service, service, service).first<FailureEpisode>();
  if (!episode || !shouldReportEpisode(service, episode, Math.floor(Date.now() / 1000))) return;
  if (await sendOwnerTelegram(env, persistentAlertText(service, episode, errorClass))) {
    await env.DB.prepare('UPDATE sync_failures SET notified = 1 WHERE id = ?').bind(failureId).run();
  }
}
