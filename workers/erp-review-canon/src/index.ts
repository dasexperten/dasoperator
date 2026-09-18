import { erpWorker, type BaseEnv } from '../../_shared/run';
// @ts-expect-error plain JS module
import { runReviewCanon } from '../../_care/review-canon.mjs';

interface Env extends BaseEnv {
  ERP_DB: D1Database;
  GITHUB_TOKEN?: string;
}

export default erpWorker<Env>('erp-review-canon', async (env, dry) => {
  const r = await runReviewCanon(env, { dry, hours: 24 });
  return { rows: dry ? r.would_fix : r.fixed, note: JSON.stringify(r).slice(0, 600) };
});
