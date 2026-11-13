// One board receipt for the combined job; it does not claim four independent seat runs.
export function boardReceipt(at, result, failure = '') {
 const day = new Date(new Date(at).getTime() + 4 * 3600000).toISOString().slice(0,10);
 const done = result?.state === 'sent' && result.complete === true;
 const delivered = result?.state === 'sent' && result.message_id;
 return {day, status:done?'done':'blocked', percent:done?100:delivered?75:0,
  note: delivered ? `Telegram ${result.message_id}; ${done?'все источники проверены':'проверка источников неполная; пробелы перечислены в отчёте'}` : `Отчёт не подтверждён: ${failure || 'проверка не завершена'}`,
  artifact:`https://dasoperator-api.dasexperten.workers.dev/api/cron-runs/online-daily?date=${day}`};
}
export async function saveBoardReceipt(db, at, result, failure = '') {
 const row=boardReceipt(at,result,failure);
 const written=await db.prepare(`INSERT INTO org_task_runs (task_id,agent_slug,due_date,status,percent,note,artifact,completed_at)
  VALUES ('ONLINE-DAILY','dasha-kozlovskaya',?,?,?,?,?,?)
  ON CONFLICT(task_id,due_date) DO UPDATE SET status=excluded.status,percent=excluded.percent,
  note=excluded.note,artifact=excluded.artifact,completed_at=excluded.completed_at`)
  .bind(row.day,row.status,row.percent,row.note,row.artifact,row.status==='done'?new Date().toISOString():null).run();
 if(!written.success)throw Error('online-daily board receipt not persisted');
 return row;
}
