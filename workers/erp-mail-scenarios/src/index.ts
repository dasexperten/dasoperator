import { erpWorker, type BaseEnv } from '../../_shared/run';

export default erpWorker<BaseEnv>('erp-mail-scenarios', async (env, dry) => {
  if (dry) return { note: 'dry · stamp skipped' };
  const n = Math.floor(Date.now() / 1000);
  const res = await env.DB.prepare(
    'UPDATE email_scenarios SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE enabled = 1',
  ).bind(n, n + 3 * 3600, n).run();
  const changed = res.meta.changes ?? 0;
  return { rows: changed, note: `${changed} enabled scenarios stamped` };
});
