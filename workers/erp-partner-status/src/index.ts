import { erpWorker, type BaseEnv } from '../../_shared/run';
import { runPartnerStatusRecalc } from '../../../api/src/lib/partner-status';

export default erpWorker<BaseEnv>('erp-partner-status', async (env, dry) => {
  if (dry) return { note: 'dry · recount skipped' };
  const changed = await runPartnerStatusRecalc(env);
  return { rows: changed, note: `${changed} partners updated` };
});
