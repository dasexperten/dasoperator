import type { Env } from '../types';
import { reelTaskText } from './ugc-reel-jobs.mjs';

export async function dispatchReel(env: Env, contentId: string, origin: string): Promise<void> {
  const row = await env.DB.prepare(`SELECT j.*,c.content_url,p.handle FROM ugc_reel_jobs j JOIN ugc_content c ON c.id=j.content_id JOIN ugc_creator_platforms p ON p.id=c.creator_platform_id WHERE j.content_id=?`).bind(contentId).first<Record<string, any>>();
  if (!row || row.status !== 'queued' || row.dispatch_attempts >= 3 || row.dispatched_at) return;
  const now = new Date().toISOString();
  const held = await env.DB.prepare(`UPDATE ugc_reel_jobs SET dispatch_attempts=dispatch_attempts+1,dispatched_at=?,updated_at=? WHERE content_id=? AND status='queued' AND dispatched_at IS NULL AND dispatch_attempts<3`).bind(now, now, contentId).run();
  if (!held.meta.changes) return;
  let error = '';
  if (!env.SEAT_DIETER_VFX || !env.EMAILER_SERVICE_SECRET) error = 'Запуск Дитера не подключён';
  else {
    try {
      const response = await env.SEAT_DIETER_VFX.fetch('https://seat/adhoc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Emailer-Service-Secret': env.EMAILER_SERVICE_SECRET },
        body: JSON.stringify({ text: reelTaskText({ content_id: contentId, content_url: row.content_url, handle: row.handle }, origin), from: 'Владелец · выбор ролика в UGC ERP' }),
        signal: AbortSignal.timeout(150_000),
      });
      const out = await response.json().catch(() => null) as { ok?: boolean; actions?: number } | null;
      if (!response.ok || out?.ok !== true) error = 'Дитер не принял задание';
      else {
        // Receipt alone must never set yellow or green. The worker calls claim when it actually starts.
        const current = await env.DB.prepare('SELECT status FROM ugc_reel_jobs WHERE content_id=?').bind(contentId).first<{ status: string }>();
        if (current?.status === 'queued') error = 'Задание доставлено Дитеру; фактическое начало работы ещё не подтверждено';
      }
    } catch { error = 'Нет подтверждения запуска Дитера'; }
  }
  await env.DB.prepare('UPDATE ugc_reel_jobs SET last_error=?,updated_at=? WHERE content_id=? AND status=\'queued\'').bind(error || null, new Date().toISOString(), contentId).run();
}
